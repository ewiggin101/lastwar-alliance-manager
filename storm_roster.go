// Copyright (c) 2026 Vervelak
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/mux"
)

// Storm rosters: who signed up for a Desert / Canyon Storm and which team
// they are on, taken from the in-game Participants screen before the battle.
// FarmOps models a storm the same way — assignments first, scores after — so
// a roster here is mirrored to storms/assignments, and the results push later
// attaches scores to that event instead of inventing an everyone-on-A roster.
//
// This is not storm_assignments (storm.html): that is the per-building
// defence planner. A roster is only membership and team.

const (
	stormTeamA          = "A"
	stormTeamB          = "B"
	stormRoleStarter    = "STARTER"
	stormRoleSubstitute = "SUBSTITUTE"
)

// stormPreferenceTeams maps the faction a member picks on the Canyon Storm
// Participants screen onto a FarmOps team. The two factions are the two task
// forces; which is A is a convention, not a game fact — change it here.
var stormPreferenceTeams = map[string]string{
	"dawnbreakers": stormTeamA,
	"rulebringers": stormTeamB,
}

type StormRosterEntry struct {
	ID           int    `json:"id"`
	StormType    string `json:"storm_type"`
	EventDate    string `json:"event_date"`
	MemberID     *int   `json:"member_id"`
	MemberName   string `json:"member_name,omitempty"`
	NameSnapshot string `json:"name_snapshot"`
	Team         string `json:"team"`
	Role         string `json:"role"`
	Preference   string `json:"preference"`
}

func initStormRosterSchema() error {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS storm_rosters (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		storm_type TEXT NOT NULL,
		event_date TEXT NOT NULL,
		member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
		name_snapshot TEXT NOT NULL,
		team TEXT NOT NULL CHECK (team IN ('A', 'B')),
		role TEXT NOT NULL DEFAULT 'STARTER' CHECK (role IN ('STARTER', 'SUBSTITUTE')),
		preference TEXT NOT NULL DEFAULT '',
		created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
		UNIQUE(storm_type, event_date, name_snapshot)
	)`)
	return err
}

func normalizeStormTeam(s string) (string, bool) {
	switch strings.ToUpper(strings.TrimSpace(s)) {
	case stormTeamA:
		return stormTeamA, true
	case stormTeamB:
		return stormTeamB, true
	}
	return "", false
}

func normalizeStormRole(s string) (string, bool) {
	switch strings.ToUpper(strings.TrimSpace(s)) {
	case "", stormRoleStarter:
		return stormRoleStarter, true
	case stormRoleSubstitute, "SUB":
		return stormRoleSubstitute, true
	}
	return "", false
}

// stormRosterDate validates the YYYY-MM-DD the roster is filed under. The
// date must be the battle's, so the results push finds the same FarmOps
// event; a sign-up screen carries no timestamp, so the caller supplies it.
func stormRosterDate(s string) (string, error) {
	s = strings.TrimSpace(s)
	if _, err := time.Parse("2006-01-02", s); err != nil {
		return "", fmt.Errorf("event_date must be YYYY-MM-DD")
	}
	return s, nil
}

// POST /api/desert-storm/roster — save (upsert) roster rows for one storm
//
//	{"storm_type":"CANYON","event_date":"2026-09-18",
//	 "entries":[{"member_name":"Kaido","preference":"Dawnbreakers"},
//	            {"member_name":"Miaaa","team":"B","role":"SUBSTITUTE"}]}
//
// A team given explicitly wins; otherwise it comes from the preference. Rows
// whose team cannot be decided go to A and are reported as "unassigned" so
// the caller can say so. Rows are keyed by name within the storm, so posting
// the roster's pages one message at a time, or re-posting a corrected page,
// updates rather than duplicates.
func saveStormRoster(w http.ResponseWriter, r *http.Request) {
	var req struct {
		StormType string `json:"storm_type"`
		EventDate string `json:"event_date"`
		Entries   []struct {
			MemberName string `json:"member_name"`
			Preference string `json:"preference"`
			Team       string `json:"team"`
			Role       string `json:"role"`
		} `json:"entries"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	stormType, err := normalizeStormType(req.StormType)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	eventDate, err := stormRosterDate(req.EventDate)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if len(req.Entries) == 0 {
		http.Error(w, "No entries provided", http.StatusBadRequest)
		return
	}

	members, err := loadAllMembers()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	tx, err := db.Begin()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer tx.Rollback()

	saved := 0
	var unmatched, unassigned []string
	for _, e := range req.Entries {
		name := strings.TrimSpace(e.MemberName)
		if name == "" {
			continue
		}
		team, ok := normalizeStormTeam(e.Team)
		if !ok {
			team, ok = stormPreferenceTeams[strings.ToLower(strings.TrimSpace(e.Preference))]
		}
		if !ok {
			team = stormTeamA
			unassigned = append(unassigned, name)
		}
		role, ok := normalizeStormRole(e.Role)
		if !ok {
			http.Error(w, fmt.Sprintf("bad role %q for %s", e.Role, name), http.StatusBadRequest)
			return
		}

		// Same matcher as the results path, so a name resolves to the same
		// member whether it arrives on the roster or on the leaderboard.
		p := DSOCRParticipant{NameSnapshot: name}
		matchDSParticipant(&p, members)
		if p.MemberID == nil {
			unmatched = append(unmatched, name)
		}

		_, err := tx.Exec(`INSERT INTO storm_rosters (storm_type, event_date, member_id, name_snapshot, team, role, preference)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(storm_type, event_date, name_snapshot)
			DO UPDATE SET member_id = excluded.member_id, team = excluded.team, role = excluded.role, preference = excluded.preference`,
			stormType, eventDate, p.MemberID, name, team, role, strings.TrimSpace(e.Preference))
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		saved++
	}
	if err := tx.Commit(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	farmOpsPushStormRosterAsync(stormType, eventDate)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"storm_type": stormType,
		"event_date": eventDate,
		"saved":      saved,
		"unmatched":  unmatched,
		"unassigned": unassigned,
		"message":    fmt.Sprintf("Roster saved: %d member(s)", saved),
	})
}

// GET /api/desert-storm/roster?type=CANYON[&date=YYYY-MM-DD] — roster rows,
// newest storm first. Without a date, every roster of that type.
func listStormRoster(w http.ResponseWriter, r *http.Request) {
	stormType, err := stormTypeParam(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	date := strings.TrimSpace(r.URL.Query().Get("date"))
	rows, err := db.Query(`
		SELECT r.id, r.storm_type, r.event_date, r.member_id, COALESCE(m.name, ''),
			r.name_snapshot, r.team, r.role, r.preference
		FROM storm_rosters r
		LEFT JOIN members m ON m.id = r.member_id
		WHERE (? = '' OR r.storm_type = ?) AND (? = '' OR r.event_date = ?)
		ORDER BY r.event_date DESC, r.team, r.role, LOWER(r.name_snapshot)`,
		stormType, stormType, date, date)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	entries := []StormRosterEntry{}
	for rows.Next() {
		var e StormRosterEntry
		var memberID sql.NullInt64
		if err := rows.Scan(&e.ID, &e.StormType, &e.EventDate, &memberID, &e.MemberName,
			&e.NameSnapshot, &e.Team, &e.Role, &e.Preference); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if memberID.Valid {
			id := int(memberID.Int64)
			e.MemberID = &id
		}
		entries = append(entries, e)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(entries)
}

// PUT /api/desert-storm/roster/{id} — fix one row's team, role or member
func updateStormRosterEntry(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(mux.Vars(r)["id"])
	var req struct {
		Team     string `json:"team"`
		Role     string `json:"role"`
		MemberID *int   `json:"member_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	team, ok := normalizeStormTeam(req.Team)
	if !ok {
		http.Error(w, "team must be A or B", http.StatusBadRequest)
		return
	}
	role, ok := normalizeStormRole(req.Role)
	if !ok {
		http.Error(w, "role must be STARTER or SUBSTITUTE", http.StatusBadRequest)
		return
	}

	var stormType, eventDate string
	if err := db.QueryRow(`SELECT storm_type, event_date FROM storm_rosters WHERE id = ?`, id).Scan(&stormType, &eventDate); err != nil {
		http.Error(w, "Roster entry not found", http.StatusNotFound)
		return
	}
	if _, err := db.Exec(`UPDATE storm_rosters SET team = ?, role = ?, member_id = ? WHERE id = ?`,
		team, role, req.MemberID, id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	farmOpsPushStormRosterAsync(stormType, eventDate)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"message": "Roster entry updated"})
}

// DELETE /api/desert-storm/roster/{id} — drop one member from a roster
func deleteStormRosterEntry(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(mux.Vars(r)["id"])
	var stormType, eventDate string
	if err := db.QueryRow(`SELECT storm_type, event_date FROM storm_rosters WHERE id = ?`, id).Scan(&stormType, &eventDate); err != nil {
		http.Error(w, "Roster entry not found", http.StatusNotFound)
		return
	}
	if _, err := db.Exec(`DELETE FROM storm_rosters WHERE id = ?`, id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// FarmOps assignments are re-sent from what is left; whether FarmOps
	// drops the removed member depends on its import being a replace.
	farmOpsPushStormRosterAsync(stormType, eventDate)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"message": "Roster entry deleted"})
}

// farmOpsPushStormRoster sends the whole roster of one storm to FarmOps
// storms/assignments, which creates the event when it does not exist yet.
func farmOpsPushStormRoster(ctx context.Context, stormType, eventDate string) (*farmOpsPushResult, error) {
	rows, err := db.Query(`
		SELECT r.name_snapshot, COALESCE(m.name, ''), COALESCE(m.farmops_member_id, ''), r.team, r.role
		FROM storm_rosters r
		LEFT JOIN members m ON m.id = r.member_id
		WHERE r.storm_type = ? AND r.event_date = ?`, stormType, eventDate)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	type assignment struct {
		MemberID string `json:"memberId,omitempty"`
		Name     string `json:"name,omitempty"`
		Team     string `json:"team"`
		Role     string `json:"role"`
	}
	var entries []assignment
	res := &farmOpsPushResult{Endpoint: "storms/assignments"}
	for rows.Next() {
		var snapshot, memberName, fid, team, role string
		if err := rows.Scan(&snapshot, &memberName, &fid, &team, &role); err != nil {
			return nil, err
		}
		name := memberName
		if name == "" {
			name = snapshot
		}
		e, byID := farmOpsEntryFor(fid, name, 0)
		entries = append(entries, assignment{MemberID: e.MemberID, Name: e.Name, Team: team, Role: role})
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
		return nil, fmt.Errorf("%s %s has no roster", stormType, eventDate)
	}
	res.Sent = len(entries)

	var body string
	res.Status, body, err = farmOpsPost(ctx, farmOpsStormAssignmentsURL, map[string]any{
		"stormType": stormType,
		"eventDate": eventDate,
		"entries":   entries,
	})
	res.applySummary(body)
	log.Printf("FarmOps push: storms/assignments %s %s sent=%d by_id=%d by_name=%d status=%d matched=%d unmatched=%v",
		stormType, eventDate, res.Sent, res.ByID, res.ByName, res.Status, res.Matched, res.Unmatched) // #nosec G706 -- validated type and date, our own ints, parsed names
	return res, err
}

func farmOpsPushStormRosterAsync(stormType, eventDate string) {
	if !farmOpsPushEnabled() {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), farmOpsPushTimeout+5*time.Second)
		defer cancel()
		if _, err := farmOpsPushStormRoster(ctx, stormType, eventDate); err != nil {
			log.Printf("FarmOps push: roster %s %s failed: %v", stormType, eventDate, err) // #nosec G706 -- validated type and date
		}
	}()
}
