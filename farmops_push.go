// Copyright (c) 2026 Vervelak
// SPDX-License-Identifier: MIT

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

// FarmOps push: the other direction from farmops_sync.go.
//
// FarmOps reads roster, power, kills, HQ and profession straight out of the
// game, so for those it is the source of truth and the sync mirrors them in.
// VS points and storm results have no game feed — they only exist because a
// screenshot was read — and the reader that produces them (the Discord relay,
// landing here) is the authoritative writer. FarmOps has the better dashboard,
// so those two metrics are pushed out to it after every save.
//
// One writer per metric, one direction per metric. Nothing is pushed that
// FarmOps already gets from the game: pushing power back would be a loop, and
// any drift would overwrite the game's own number.
//
// Entries go by FarmOps' exact member id wherever the sync has linked one
// (96 of 99 members at the time of writing), so FarmOps does no fuzzy
// matching on its side. Unlinked members fall back to name.
//
// A separate WRITE-scoped key is used. The read key stays read-only: one
// credential per consumer, and a leaked read key cannot alter FarmOps data.

const (
	farmOpsDuelsURL            = "https://www.lastwar.farm/api/v1/alliance/members/duels"
	farmOpsStormsURL           = "https://www.lastwar.farm/api/v1/alliance/storms"
	farmOpsStormAssignmentsURL = "https://www.lastwar.farm/api/v1/alliance/storms/assignments"
	farmOpsStormScoresURL      = "https://www.lastwar.farm/api/v1/alliance/storms/scores"
	farmOpsPushTimeout         = 30 * time.Second
)

// farmOpsEntry is the shape every FarmOps import endpoint takes.
type farmOpsEntry struct {
	MemberID string `json:"memberId,omitempty"`
	Name     string `json:"name,omitempty"`
	Score    int64  `json:"score"`
}

// farmOpsImportSummary is what every FarmOps import endpoint returns.
type farmOpsImportSummary struct {
	Data struct {
		MatchedCount   int      `json:"matchedCount"`
		UnmatchedCount int      `json:"unmatchedCount"`
		Unmatched      []string `json:"unmatched"`
		UnknownIDs     []string `json:"unknownIds"`
	} `json:"data"`
}

type farmOpsPushResult struct {
	Endpoint     string   `json:"endpoint"`
	Sent         int      `json:"sent"`
	ByID         int      `json:"by_id"`
	ByName       int      `json:"by_name"`
	Status       int      `json:"status"`
	Matched      int      `json:"matched"`
	Unmatched    []string `json:"unmatched,omitempty"`
	UnknownIDs   []string `json:"unknown_ids,omitempty"`
	CreatedEvent bool     `json:"created_event,omitempty"`
	Summary      string   `json:"summary"`
}

// applySummary folds FarmOps' response into the result and reports the
// names it could not place — those are the ones a human needs to look at.
func (r *farmOpsPushResult) applySummary(raw string) {
	r.Summary = raw
	var sum farmOpsImportSummary
	if json.Unmarshal([]byte(raw), &sum) == nil {
		r.Matched = sum.Data.MatchedCount
		r.Unmatched = sum.Data.Unmatched
		r.UnknownIDs = sum.Data.UnknownIDs
	}
}

func farmOpsWriteKey() string {
	return strings.TrimSpace(os.Getenv("LASTWAR_FARM_WRITE_KEY"))
}

// farmOpsPushEnabled is checked at the call sites so a missing key costs one
// string comparison per save, not a log line each time.
func farmOpsPushEnabled() bool { return farmOpsWriteKey() != "" }

func farmOpsPost(ctx context.Context, url string, payload any) (int, string, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return 0, "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Authorization", "Bearer "+farmOpsWriteKey())
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "lastwar-alliance-manager/1.0")

	resp, err := (&http.Client{Timeout: farmOpsPushTimeout}).Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	summary, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
	text := strings.TrimSpace(string(summary))
	if resp.StatusCode != http.StatusOK {
		return resp.StatusCode, text, fmt.Errorf("lastwar.farm returned HTTP %d: %s", resp.StatusCode, text)
	}
	return resp.StatusCode, text, nil
}

func farmOpsGet(ctx context.Context, url string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+farmOpsWriteKey())
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "lastwar-alliance-manager/1.0")
	resp, err := (&http.Client{Timeout: farmOpsPushTimeout}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("lastwar.farm returned HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(out)
}

// farmOpsStormExists reports whether FarmOps already has an event of this
// type on this date — i.e. someone planned it there, with real team
// assignments that a push must not overwrite.
func farmOpsStormExists(ctx context.Context, stormType, eventDate string) (bool, error) {
	var raw json.RawMessage
	if err := farmOpsGet(ctx, farmOpsStormsURL, &raw); err != nil {
		return false, err
	}
	var events []struct {
		Type      string `json:"type"`
		EventDate string `json:"eventDate"`
	}
	// The list endpoint has answered both as a bare array and wrapped in
	// {"data": [...]}; accept either.
	if json.Unmarshal(raw, &events) != nil {
		var wrapped struct {
			Data []struct {
				Type      string `json:"type"`
				EventDate string `json:"eventDate"`
			} `json:"data"`
		}
		if err := json.Unmarshal(raw, &wrapped); err != nil {
			return false, fmt.Errorf("unexpected storms list shape: %w", err)
		}
		events = wrapped.Data
	}
	for _, e := range events {
		if strings.EqualFold(e.Type, stormType) && e.EventDate == eventDate {
			return true, nil
		}
	}
	return false, nil
}

// farmOpsEntryFor builds one entry, preferring the exact id.
func farmOpsEntryFor(farmopsID, name string, score int64) (farmOpsEntry, bool) {
	if id := strings.TrimSpace(farmopsID); id != "" {
		return farmOpsEntry{MemberID: id, Score: score}, true
	}
	return farmOpsEntry{Name: name, Score: score}, false
}

// vsDayOffset maps LWM's day column onto days after the week's Monday.
var vsDayOffset = map[string]int{
	"monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3, "friday": 4, "saturday": 5,
}

// vsScoredOn turns LWM's (week Monday, day column) into the calendar date
// FarmOps wants as scoredOn.
func vsScoredOn(weekDate, day string) (string, error) {
	off, ok := vsDayOffset[strings.ToLower(day)]
	if !ok {
		return "", fmt.Errorf("invalid day %q", day)
	}
	monday, err := time.Parse("2006-01-02", weekDate)
	if err != nil {
		return "", fmt.Errorf("invalid week date %q: %w", weekDate, err)
	}
	return monday.AddDate(0, 0, off).Format("2006-01-02"), nil
}

// farmOpsPushDuels sends one day of VS points.
//
// Only rows with a score above zero are sent. vs_points day columns default to
// 0, so a zero cannot be told apart from "not ingested yet" — and pushing an
// unread day as an explicit 0 would tell FarmOps a member scored nothing when
// the truth is nobody has looked. For FarmOps' purpose (did they clear the
// daily threshold) a missing entry and a zero are the same answer anyway.
func farmOpsPushDuels(ctx context.Context, weekDate, day string) (*farmOpsPushResult, error) {
	day = strings.ToLower(day)
	if _, ok := vsDayOffset[day]; !ok {
		return nil, fmt.Errorf("invalid day %q", day)
	}
	scoredOn, err := vsScoredOn(weekDate, day)
	if err != nil {
		return nil, err
	}

	// #nosec G202 -- day is validated against vsDayOffset above, not user input.
	rows, err := db.Query(fmt.Sprintf(`
		SELECT m.name, COALESCE(m.farmops_member_id, ''), v.%s
		FROM vs_points v JOIN members m ON m.id = v.member_id
		WHERE v.week_date = ? AND v.%s > 0 AND m.deleted_at IS NULL`, day, day), weekDate)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var entries []farmOpsEntry
	res := &farmOpsPushResult{Endpoint: "members/duels"}
	for rows.Next() {
		var name, fid string
		var score int64
		if err := rows.Scan(&name, &fid, &score); err != nil {
			return nil, err
		}
		e, byID := farmOpsEntryFor(fid, name, score)
		entries = append(entries, e)
		if byID {
			res.ByID++
		} else {
			res.ByName++
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(entries) == 0 {
		return nil, fmt.Errorf("no VS scores above zero for %s %s", weekDate, day)
	}

	res.Sent = len(entries)
	var body string
	res.Status, body, err = farmOpsPost(ctx, farmOpsDuelsURL, map[string]any{
		"scoredOn": scoredOn,
		"entries":  entries,
	})
	res.applySummary(body)
	log.Printf("FarmOps push: duels %s (%s %s) sent=%d by_id=%d by_name=%d status=%d matched=%d unmatched=%v",
		scoredOn, weekDate, day, res.Sent, res.ByID, res.ByName, res.Status, res.Matched, res.Unmatched) // #nosec G706 -- our own ints, a validated date/day, and a parsed []string of names
	return res, err
}

// farmOpsPushStormScores sends one Desert Storm event's results.
func farmOpsPushStormScores(ctx context.Context, eventID int) (*farmOpsPushResult, error) {
	var eventDate string
	if err := db.QueryRow(`SELECT event_date FROM desert_storm_events WHERE id = ?`, eventID).Scan(&eventDate); err != nil {
		return nil, fmt.Errorf("desert storm event %d: %w", eventID, err)
	}

	rows, err := db.Query(`
		SELECT p.name_snapshot, COALESCE(m.name, ''), COALESCE(m.farmops_member_id, ''), p.damage
		FROM desert_storm_participants p
		LEFT JOIN members m ON m.id = p.member_id
		WHERE p.event_id = ?`, eventID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var entries []farmOpsEntry
	res := &farmOpsPushResult{Endpoint: "storms/scores"}
	for rows.Next() {
		var snapshot, memberName, fid string
		var damage int64
		if err := rows.Scan(&snapshot, &memberName, &fid, &damage); err != nil {
			return nil, err
		}
		// Prefer the roster name over the screenshot snapshot when the
		// participant was matched; the snapshot is whatever OCR read.
		name := memberName
		if name == "" {
			name = snapshot
		}
		e, byID := farmOpsEntryFor(fid, name, damage)
		entries = append(entries, e)
		if byID {
			res.ByID++
		} else {
			res.ByName++
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(entries) == 0 {
		return nil, fmt.Errorf("desert storm event %d has no participants", eventID)
	}

	res.Sent = len(entries)

	// Scores can only attach to an existing event ("Import assignments
	// first", per the API). If the storm was planned in FarmOps the event
	// and its real team assignments already exist and must be left alone.
	// If not, create it from the participants: everyone with a score played,
	// so STARTER is accurate; the team is unknown to LWM, so all go to A and
	// the same default is passed to scores for consistency.
	exists, err := farmOpsStormExists(ctx, "DESERT", eventDate)
	if err != nil {
		return res, fmt.Errorf("checking for existing storm event: %w", err)
	}
	if !exists {
		type assignment struct {
			MemberID string `json:"memberId,omitempty"`
			Name     string `json:"name,omitempty"`
			Team     string `json:"team"`
			Role     string `json:"role"`
		}
		roster := make([]assignment, 0, len(entries))
		for _, e := range entries {
			roster = append(roster, assignment{MemberID: e.MemberID, Name: e.Name, Team: "A", Role: "STARTER"})
		}
		status, body, err := farmOpsPost(ctx, farmOpsStormAssignmentsURL, map[string]any{
			"stormType": "DESERT",
			"eventDate": eventDate,
			"entries":   roster,
		})
		if err != nil {
			res.Status = status
			res.Summary = body
			return res, fmt.Errorf("creating storm event: %w", err)
		}
		res.CreatedEvent = true
		log.Printf("FarmOps push: created DESERT %s roster from %d participant(s)", eventDate, len(roster)) // #nosec G706 -- validated date and an int
	}

	var body string
	res.Status, body, err = farmOpsPost(ctx, farmOpsStormScoresURL, map[string]any{
		"stormType":   "DESERT",
		"eventDate":   eventDate,
		"defaultTeam": "A",
		"entries":     entries,
	})
	res.applySummary(body)
	log.Printf("FarmOps push: storms/scores DESERT %s (event %d) sent=%d by_id=%d by_name=%d created_event=%v status=%d matched=%d unmatched=%v",
		eventDate, eventID, res.Sent, res.ByID, res.ByName, res.CreatedEvent, res.Status, res.Matched, res.Unmatched) // #nosec G706 -- our own ints and a parsed []string of names
	return res, err
}

// Fire-and-forget wrappers for the save paths. The relay is waiting on the
// save response; a FarmOps hiccup must not slow or fail that. The outcome is
// logged either way, so a failed push is visible in the container log.
func farmOpsPushDuelsAsync(weekDate, day string) {
	if !farmOpsPushEnabled() {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), farmOpsPushTimeout+5*time.Second)
		defer cancel()
		if _, err := farmOpsPushDuels(ctx, weekDate, day); err != nil {
			log.Printf("FarmOps push: duels %s %s failed: %v", weekDate, day, err) // #nosec G706 -- values are a validated date and day name
		}
	}()
}

func farmOpsPushStormScoresAsync(eventID int) {
	if !farmOpsPushEnabled() {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), farmOpsPushTimeout+5*time.Second)
		defer cancel()
		if _, err := farmOpsPushStormScores(ctx, eventID); err != nil {
			log.Printf("FarmOps push: storm event %d failed: %v", eventID, err)
		}
	}()
}

// handleFarmOpsPush pushes one day of VS or one storm event on demand:
//
//	{"kind":"vs","week_date":"2026-09-07","day":"monday"}
//	{"kind":"storm","event_id":12}
//
// Exists so data ingested before the push was wired (or after a FarmOps
// outage) can be mirrored without re-posting screenshots. Gated to rank
// management, like the sync.
func handleFarmOpsPush(w http.ResponseWriter, r *http.Request) {
	if !farmOpsPushEnabled() {
		http.Error(w, "FarmOps push is not configured (LASTWAR_FARM_WRITE_KEY is not set)", http.StatusServiceUnavailable)
		return
	}
	var req struct {
		Kind     string `json:"kind"`
		WeekDate string `json:"week_date"`
		Day      string `json:"day"`
		EventID  int    `json:"event_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), farmOpsPushTimeout+5*time.Second)
	defer cancel()

	var res *farmOpsPushResult
	var err error
	switch req.Kind {
	case "vs":
		res, err = farmOpsPushDuels(ctx, req.WeekDate, req.Day)
	case "storm":
		res, err = farmOpsPushStormScores(ctx, req.EventID)
	default:
		http.Error(w, `kind must be "vs" or "storm"`, http.StatusBadRequest)
		return
	}
	if err != nil {
		status := http.StatusBadGateway
		if res == nil {
			status = http.StatusBadRequest
		}
		http.Error(w, err.Error(), status)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(res)
}

func logFarmOpsPushStatus() {
	if farmOpsPushEnabled() {
		log.Println("FarmOps push: enabled (VS points and Desert Storm results are mirrored after each save)")
	} else {
		log.Println("FarmOps push: LASTWAR_FARM_WRITE_KEY not set, push disabled")
	}
}
