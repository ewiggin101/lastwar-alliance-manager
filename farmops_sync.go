// Copyright (c) 2026 Vervelak
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// FarmOps (lastwar.farm) publishes a single JSON bundle at /alliance/export that
// contains the alliance roster plus power / kill / hero-power history and weekly
// tech donations. Its "Auto Sync" add-on keeps power, kills, HQ level, profession
// and donations current with no screenshots, so this sync pulls that bundle on a
// timer and mirrors it into the local schema. VS points and storm attendance are
// NOT in the export (they need screenshots) and are handled elsewhere.
const farmOpsExportURL = "https://www.lastwar.farm/api/v1/alliance/export"

const (
	farmOpsDefaultSyncInterval = 6 * time.Hour
	farmOpsSyncTimeout         = 2 * time.Minute
	// sqliteDatetimeLayout matches the format SQLite's CURRENT_TIMESTAMP writes,
	// so synced history rows sort alongside existing ones.
	sqliteDatetimeLayout = "2006-01-02 15:04:05"
)

// farmOpsExport is the subset of GET /alliance/export this app consumes.
type farmOpsExport struct {
	Data struct {
		Alliance struct {
			Name string `json:"name"`
		} `json:"alliance"`
		ExportedAt   string                `json:"exportedAt"`
		Members      []farmOpsExportMember `json:"members"`
		PowerHistory []farmOpsHistoryRow   `json:"powerHistory"`
		KillHistory  []farmOpsHistoryRow   `json:"killHistory"`
		ThpHistory   []farmOpsHistoryRow   `json:"thpHistory"`
		Donations    []farmOpsDonationRow  `json:"donations"`
	} `json:"data"`
}

type farmOpsExportMember struct {
	ID                     string `json:"id"`
	Name                   string `json:"name"`
	GameUID                string `json:"gameUid"`
	Role                   string `json:"role"`
	Status                 string `json:"status"`
	CurrentHqLevel         *int   `json:"currentHqLevel"`
	CurrentProfessionType  *int   `json:"currentProfessionType"`
	CurrentProfessionLevel *int   `json:"currentProfessionLevel"`
}

// farmOpsHistoryRow is shared by the powerHistory, killHistory and thpHistory
// arrays; only one of Power / Kills / TotalHeroPower is populated per array.
type farmOpsHistoryRow struct {
	ID             string `json:"id"`
	MemberID       string `json:"memberId"`
	Power          string `json:"power"`
	Kills          string `json:"kills"`
	TotalHeroPower string `json:"totalHeroPower"`
	RecordedAt     string `json:"recordedAt"`
	Source         string `json:"source"`
}

type farmOpsDonationRow struct {
	ID        string `json:"id"`
	MemberID  string `json:"memberId"`
	Total     string `json:"total"`
	WeekStart string `json:"weekStart"`
}

// farmOpsSyncResult is the JSON summary returned by POST /api/farmops/sync and
// logged after each scheduled run.
type farmOpsSyncResult struct {
	Source           string   `json:"source"`
	Alliance         string   `json:"alliance"`
	ExportedAt       string   `json:"exported_at"`
	MembersMatched   int      `json:"members_matched"`
	MembersLinked    int      `json:"members_linked"`
	MembersUnmatched int      `json:"members_unmatched"`
	Unmatched        []string `json:"unmatched"`
	// UnmatchedFarmOps lists members present in the FarmOps export that no
	// local member matched. Pair these against Unmatched to see what a local
	// member should be renamed to: FarmOps reads the roster out of the game,
	// so its spelling is the authoritative one. Without this the result said
	// which members were stranded but never what to call them instead.
	UnmatchedFarmOps []string `json:"unmatched_farmops"`
	SnapshotUpdates  int      `json:"snapshot_updates"`
	PowerRows        int      `json:"power_rows_inserted"`
	KillRows         int      `json:"kill_rows_inserted"`
	ThpRows          int      `json:"thp_rows_inserted"`
	DonationWeeks    []string `json:"donation_weeks"`
	DonationRows     int      `json:"donation_rows"`
}

// farmOpsSyncMu serialises runs so a scheduled tick and a manual POST cannot
// overlap on the same SQLite file.
var farmOpsSyncMu sync.Mutex

// migrateFarmOpsSchema adds the columns and tables the export sync needs. It is
// idempotent and called from initDB on every startup.
func migrateFarmOpsSchema() error {
	// Stable join keys onto FarmOps, plus current snapshot fields it exposes.
	cols := []struct{ table, column, alter string }{
		{"members", "game_uid", `ALTER TABLE members ADD COLUMN game_uid TEXT`},
		{"members", "farmops_member_id", `ALTER TABLE members ADD COLUMN farmops_member_id TEXT`},
		{"members", "hq_level", `ALTER TABLE members ADD COLUMN hq_level INTEGER`},
		{"members", "profession_type", `ALTER TABLE members ADD COLUMN profession_type INTEGER`},
		{"members", "profession_level", `ALTER TABLE members ADD COLUMN profession_level INTEGER`},
		{"power_history", "source", `ALTER TABLE power_history ADD COLUMN source TEXT`},
		{"power_history", "external_id", `ALTER TABLE power_history ADD COLUMN external_id TEXT`},
		{"tech_donations", "source", `ALTER TABLE tech_donations ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'`},
		{"tech_donations", "external_id", `ALTER TABLE tech_donations ADD COLUMN external_id TEXT`},
	}
	for _, c := range cols {
		if err := farmOpsEnsureColumn(c.table, c.column, c.alter); err != nil {
			return err
		}
	}

	stmts := []string{
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_members_game_uid ON members(game_uid) WHERE game_uid IS NOT NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_power_history_external ON power_history(external_id) WHERE external_id IS NOT NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_tech_donations_external ON tech_donations(external_id) WHERE external_id IS NOT NULL`,

		`CREATE TABLE IF NOT EXISTS kill_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			member_id INTEGER NOT NULL,
			kills INTEGER NOT NULL,
			recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			source TEXT,
			external_id TEXT,
			FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_kill_history_member ON kill_history(member_id, recorded_at DESC)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_kill_history_external ON kill_history(external_id) WHERE external_id IS NOT NULL`,

		`CREATE TABLE IF NOT EXISTS thp_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			member_id INTEGER NOT NULL,
			total_hero_power INTEGER NOT NULL,
			recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			source TEXT,
			external_id TEXT,
			FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_thp_history_member ON thp_history(member_id, recorded_at DESC)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_thp_history_external ON thp_history(external_id) WHERE external_id IS NOT NULL`,
	}
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			return err
		}
	}
	return nil
}

// farmOpsEnsureColumn runs ALTER TABLE ... ADD COLUMN when the column is missing.
func farmOpsEnsureColumn(table, column, alterSQL string) error {
	var exists bool
	// #nosec G201 -- table is a compile-time constant from migrateFarmOpsSchema, not user input.
	q := fmt.Sprintf(`SELECT COUNT(*) > 0 FROM pragma_table_info('%s') WHERE name = ?`, table)
	if err := db.QueryRow(q, column).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return nil
	}
	if _, err := db.Exec(alterSQL); err != nil {
		return err
	}
	log.Printf("Database migration: added column %s.%s", table, column)
	return nil
}

// fetchFarmOpsExport pulls and decodes GET /alliance/export.
func fetchFarmOpsExport(ctx context.Context) (*farmOpsExport, error) {
	apiKey := strings.TrimSpace(os.Getenv("LASTWAR_FARM_API_KEY"))
	if apiKey == "" {
		return nil, fmt.Errorf("LASTWAR_FARM_API_KEY not set")
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, farmOpsExportURL, nil)
	if err != nil {
		return nil, err
	}
	if strings.HasPrefix(strings.ToLower(apiKey), "bearer ") {
		req.Header.Set("Authorization", apiKey)
	} else {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "lastwar-alliance-manager/1.0")

	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("lastwar.farm export returned HTTP %d", resp.StatusCode)
	}

	var export farmOpsExport
	if err := json.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(&export); err != nil {
		return nil, err
	}
	return &export, nil
}

// runFarmOpsSync fetches the export and mirrors it into the local database in a
// single transaction. Local members are linked to FarmOps by game UID (exact) or,
// failing that, a unique normalized-name match, at which point the game UID is
// stored so later syncs are exact. Members with no match are reported, never
// created.
func runFarmOpsSync(ctx context.Context) (*farmOpsSyncResult, error) {
	farmOpsSyncMu.Lock()
	defer farmOpsSyncMu.Unlock()

	export, err := fetchFarmOpsExport(ctx)
	if err != nil {
		return nil, err
	}

	res := &farmOpsSyncResult{
		Source:           "lastwar.farm",
		Alliance:         export.Data.Alliance.Name,
		ExportedAt:       export.Data.ExportedAt,
		Unmatched:        []string{},
		UnmatchedFarmOps: []string{},
	}

	fopsByUID := make(map[string]farmOpsExportMember, len(export.Data.Members))
	fopsByName := make(map[string][]farmOpsExportMember, len(export.Data.Members))
	fopsByID := make(map[string]farmOpsExportMember, len(export.Data.Members))
	for _, m := range export.Data.Members {
		fopsByID[m.ID] = m
		if m.GameUID != "" {
			fopsByUID[m.GameUID] = m
		}
		if key := normalizeName(m.Name); key != "" {
			fopsByName[key] = append(fopsByName[key], m)
		}
	}

	rows, err := db.Query(`
		SELECT id, name, COALESCE(nickname, ''), COALESCE(game_uid, '')
		FROM members
		WHERE deleted_at IS NULL
	`)
	if err != nil {
		return nil, err
	}
	type localMember struct {
		id       int
		name     string
		nickname string
		gameUID  string
	}
	locals := make([]localMember, 0, len(export.Data.Members))
	for rows.Next() {
		var lm localMember
		if err := rows.Scan(&lm.id, &lm.name, &lm.nickname, &lm.gameUID); err != nil {
			rows.Close()
			return nil, err
		}
		locals = append(locals, lm)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	tx, err := db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	// FarmOps member id -> local member id, and local id -> display name.
	linkTo := make(map[string]int, len(locals))
	localName := make(map[int]string, len(locals))
	res.Unmatched = make([]string, 0, len(locals))

	for _, lm := range locals {
		localName[lm.id] = lm.name

		var match *farmOpsExportMember
		if lm.gameUID != "" {
			if m, ok := fopsByUID[lm.gameUID]; ok {
				m := m
				match = &m
			}
		}
		if match == nil {
			if c := fopsByName[normalizeName(lm.name)]; len(c) == 1 {
				match = &c[0]
			} else if lm.nickname != "" {
				if c := fopsByName[normalizeName(lm.nickname)]; len(c) == 1 {
					match = &c[0]
				}
			}
		}
		if match == nil {
			res.MembersUnmatched++
			res.Unmatched = append(res.Unmatched, lm.name)
			continue
		}

		res.MembersMatched++
		linkTo[match.ID] = lm.id

		if lm.gameUID == "" {
			if _, err := tx.Exec(
				`UPDATE members SET game_uid = ?, farmops_member_id = ? WHERE id = ?`,
				match.GameUID, match.ID, lm.id,
			); err != nil {
				return nil, err
			}
			res.MembersLinked++
		} else if _, err := tx.Exec(
			`UPDATE members SET farmops_member_id = ? WHERE id = ? AND (farmops_member_id IS NULL OR farmops_member_id <> ?)`,
			match.ID, lm.id, match.ID,
		); err != nil {
			return nil, err
		}

		if _, err := tx.Exec(
			`UPDATE members SET hq_level = ?, profession_type = ?, profession_level = ? WHERE id = ?`,
			farmOpsNullInt(match.CurrentHqLevel),
			farmOpsNullInt(match.CurrentProfessionType),
			farmOpsNullInt(match.CurrentProfessionLevel),
			lm.id,
		); err != nil {
			return nil, err
		}
		res.SnapshotUpdates++
	}

	if res.PowerRows, err = insertFarmOpsHistory(tx, "power_history", "power",
		export.Data.PowerHistory, linkTo, func(r farmOpsHistoryRow) string { return r.Power }); err != nil {
		return nil, err
	}
	if res.KillRows, err = insertFarmOpsHistory(tx, "kill_history", "kills",
		export.Data.KillHistory, linkTo, func(r farmOpsHistoryRow) string { return r.Kills }); err != nil {
		return nil, err
	}
	if res.ThpRows, err = insertFarmOpsHistory(tx, "thp_history", "total_hero_power",
		export.Data.ThpHistory, linkTo, func(r farmOpsHistoryRow) string { return r.TotalHeroPower }); err != nil {
		return nil, err
	}

	weeks, donationRows, err := syncFarmOpsDonations(tx, export.Data.Donations, linkTo, localName, fopsByID)
	if err != nil {
		return nil, err
	}
	res.DonationWeeks = weeks
	res.DonationRows = donationRows

	// Whatever the export offered that nothing claimed. Sorted so the list is
	// stable between runs and diffable.
	for _, m := range export.Data.Members {
		if _, linked := linkTo[m.ID]; !linked {
			res.UnmatchedFarmOps = append(res.UnmatchedFarmOps, m.Name)
		}
	}
	sort.Strings(res.UnmatchedFarmOps)

	if err := tx.Commit(); err != nil {
		return nil, err
	}

	log.Printf("FarmOps sync: alliance=%q matched=%d linked=%d unmatched=%d power+%d kill+%d thp+%d donations=%d %v",
		res.Alliance, res.MembersMatched, res.MembersLinked, res.MembersUnmatched,
		res.PowerRows, res.KillRows, res.ThpRows, res.DonationRows, res.DonationWeeks)

	// Log both sides of the mismatch. A stranded local member is only half the
	// story — without the export's spelling there is nothing to rename it to,
	// and the sync endpoint needs R4/R5, so the log is the accessible copy.
	if len(res.Unmatched) > 0 || len(res.UnmatchedFarmOps) > 0 {
		log.Printf("FarmOps sync: unmatched local=%v", res.Unmatched)          // #nosec G706 -- %v of a []string built from the local DB
		log.Printf("FarmOps sync: unmatched farmops=%v", res.UnmatchedFarmOps) // #nosec G706 -- %v of a []string from the export
	}
	return res, nil
}

// insertFarmOpsHistory appends history rows for linked members, skipping any row
// whose FarmOps id was already imported (partial unique index on external_id).
func insertFarmOpsHistory(
	tx *sql.Tx,
	table, valueCol string,
	rows []farmOpsHistoryRow,
	linkTo map[string]int,
	pick func(farmOpsHistoryRow) string,
) (int, error) {
	// #nosec G201 -- table and valueCol are compile-time constants from runFarmOpsSync.
	stmt := fmt.Sprintf(
		`INSERT OR IGNORE INTO %s (member_id, %s, recorded_at, source, external_id) VALUES (?, ?, ?, ?, ?)`,
		table, valueCol,
	)
	inserted := 0
	for _, r := range rows {
		localID, ok := linkTo[r.MemberID]
		if !ok {
			continue
		}
		value, err := strconv.ParseInt(strings.TrimSpace(pick(r)), 10, 64)
		if err != nil {
			continue
		}
		source := r.Source
		if source == "" {
			source = "farmops"
		}
		result, err := tx.Exec(stmt, localID, value, farmOpsTime(r.RecordedAt), source, r.ID)
		if err != nil {
			return inserted, err
		}
		if affected, _ := result.RowsAffected(); affected > 0 {
			inserted++
		}
	}
	return inserted, nil
}

// syncFarmOpsDonations replaces the FarmOps-sourced weekly donation rows for each
// week present in the export, leaving any manually entered rows untouched.
func syncFarmOpsDonations(
	tx *sql.Tx,
	donations []farmOpsDonationRow,
	linkTo map[string]int,
	localName map[int]string,
	fopsByID map[string]farmOpsExportMember,
) ([]string, int, error) {
	byWeek := make(map[string][]farmOpsDonationRow)
	for _, d := range donations {
		week := farmOpsDateOnly(d.WeekStart)
		if week == "" {
			continue
		}
		byWeek[week] = append(byWeek[week], d)
	}

	weeks := make([]string, 0, len(byWeek))
	for week := range byWeek {
		weeks = append(weeks, week)
	}
	sort.Strings(weeks)

	total := 0
	for _, week := range weeks {
		group := byWeek[week]
		if _, err := tx.Exec(
			`DELETE FROM tech_donations WHERE donation_type = 'weekly' AND week_date = ? AND source = 'farmops'`,
			week,
		); err != nil {
			return nil, total, err
		}

		sort.SliceStable(group, func(i, j int) bool {
			return farmOpsParseInt(group[i].Total) > farmOpsParseInt(group[j].Total)
		})

		for i, d := range group {
			var memberID interface{}
			name := ""
			if localID, ok := linkTo[d.MemberID]; ok {
				memberID = localID
				name = localName[localID]
			} else if fm, ok := fopsByID[d.MemberID]; ok {
				name = fm.Name
			}
			if name == "" {
				name = "unknown"
			}
			if _, err := tx.Exec(
				`INSERT OR IGNORE INTO tech_donations
					(member_id, name_snapshot, donation_type, week_date, amount, rank_in_snapshot, source, external_id)
				 VALUES (?, ?, 'weekly', ?, ?, ?, 'farmops', ?)`,
				memberID, name, week, farmOpsParseInt(d.Total), i+1, d.ID,
			); err != nil {
				return nil, total, err
			}
			total++
		}
	}
	return weeks, total, nil
}

// handleFarmOpsSync runs a sync on demand. Gated to rank management, like the
// merit THP refresh.
func handleFarmOpsSync(w http.ResponseWriter, r *http.Request) {
	result, err := runFarmOpsSync(r.Context())
	if err != nil {
		http.Error(w, "FarmOps sync failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(result); err != nil {
		log.Printf("FarmOps sync: encode response: %v", err)
	}
}

// startFarmOpsSyncLoop runs an initial sync shortly after boot and then on a
// timer. It is a no-op when no API key is configured. Intended to be run in its
// own goroutine for the lifetime of the process.
func startFarmOpsSyncLoop() {
	if strings.TrimSpace(os.Getenv("LASTWAR_FARM_API_KEY")) == "" {
		log.Println("FarmOps sync: LASTWAR_FARM_API_KEY not set, background sync disabled")
		return
	}

	interval := farmOpsDefaultSyncInterval
	if v := strings.TrimSpace(os.Getenv("LASTWAR_FARM_SYNC_INTERVAL")); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			interval = d
		} else {
			log.Printf("FarmOps sync: invalid LASTWAR_FARM_SYNC_INTERVAL %q, using %s", v, interval) // #nosec G706 -- %q prevents log injection; value is an operator-set env var
		}
	}
	log.Printf("FarmOps sync: background sync enabled, every %s", interval) // #nosec G706 -- interval is a parsed time.Duration

	runOnce := func() {
		ctx, cancel := context.WithTimeout(context.Background(), farmOpsSyncTimeout)
		defer cancel()
		if _, err := runFarmOpsSync(ctx); err != nil {
			log.Printf("FarmOps sync: %v", err)
		}
	}

	time.AfterFunc(30*time.Second, runOnce)

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		runOnce()
	}
}

// farmOpsTime converts an RFC3339 timestamp to SQLite's datetime text format so
// synced rows sort next to rows written with CURRENT_TIMESTAMP. Unparseable
// input falls back to now.
func farmOpsTime(s string) string {
	t, err := time.Parse(time.RFC3339, strings.TrimSpace(s))
	if err != nil {
		return time.Now().UTC().Format(sqliteDatetimeLayout)
	}
	return t.UTC().Format(sqliteDatetimeLayout)
}

// farmOpsDateOnly returns the YYYY-MM-DD portion of an RFC3339 timestamp.
func farmOpsDateOnly(s string) string {
	t, err := time.Parse(time.RFC3339, strings.TrimSpace(s))
	if err != nil {
		return ""
	}
	return t.UTC().Format("2006-01-02")
}

// farmOpsParseInt parses a base-10 integer string, returning 0 on failure.
// FarmOps encodes all numeric fields as strings.
func farmOpsParseInt(s string) int64 {
	n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil {
		return 0
	}
	return n
}

// farmOpsNullInt maps a nil *int to a SQL NULL and a non-nil one to its value.
func farmOpsNullInt(p *int) interface{} {
	if p == nil {
		return nil
	}
	return *p
}
