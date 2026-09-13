// Copyright (c) 2026 Vervelak
// SPDX-License-Identifier: MIT

package main

import "testing"

// LWM stores VS points as one row per week keyed by the week's Monday, with a
// column per day. FarmOps wants the calendar date the score was earned.
func TestVSScoredOn(t *testing.T) {
	tests := []struct{ week, day, want string }{
		{"2026-09-07", "monday", "2026-09-07"},
		{"2026-09-07", "tuesday", "2026-09-08"},
		{"2026-09-07", "saturday", "2026-09-12"},
		{"2026-09-07", "Wednesday", "2026-09-09"}, // case-insensitive
		{"2026-12-28", "saturday", "2027-01-02"},  // crosses a year boundary
	}
	for _, tt := range tests {
		got, err := vsScoredOn(tt.week, tt.day)
		if err != nil || got != tt.want {
			t.Errorf("vsScoredOn(%q, %q) = %q, %v; want %q", tt.week, tt.day, got, err, tt.want)
		}
	}
	for _, bad := range [][2]string{{"2026-09-07", "sunday"}, {"2026-09-07", ""}, {"not-a-date", "monday"}} {
		if _, err := vsScoredOn(bad[0], bad[1]); err == nil {
			t.Errorf("vsScoredOn(%q, %q) should fail", bad[0], bad[1])
		}
	}
}

// The exact FarmOps id is preferred whenever the sync has linked one; the
// name is the fallback and FarmOps fuzzy-matches it. Never both.
func TestFarmOpsEntryFor(t *testing.T) {
	e, byID := farmOpsEntryFor("cmtq123", "Sporky1", 5000)
	if !byID || e.MemberID != "cmtq123" || e.Name != "" || e.Score != 5000 {
		t.Errorf("linked member: got %+v byID=%v", e, byID)
	}
	e, byID = farmOpsEntryFor("", "Lasiria", 42)
	if byID || e.MemberID != "" || e.Name != "Lasiria" || e.Score != 42 {
		t.Errorf("unlinked member: got %+v byID=%v", e, byID)
	}
	e, byID = farmOpsEntryFor("   ", "X", 1)
	if byID || e.MemberID != "" {
		t.Errorf("whitespace id must count as unlinked: got %+v byID=%v", e, byID)
	}
}

func TestFarmOpsPushDisabledWithoutKey(t *testing.T) {
	t.Setenv("LASTWAR_FARM_WRITE_KEY", "")
	if farmOpsPushEnabled() {
		t.Error("push must be disabled when LASTWAR_FARM_WRITE_KEY is empty")
	}
	t.Setenv("LASTWAR_FARM_WRITE_KEY", "fops_live_test")
	if !farmOpsPushEnabled() {
		t.Error("push must be enabled when LASTWAR_FARM_WRITE_KEY is set")
	}
}
