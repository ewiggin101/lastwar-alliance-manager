// Copyright (c) 2026 Vervelak
// SPDX-License-Identifier: MIT

package main

import "testing"

func TestFarmOpsTime(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"2026-09-07T21:11:34.148Z", "2026-09-07 21:11:34"},
		{"2026-09-07T02:09:56Z", "2026-09-07 02:09:56"},
		{"2026-09-07T23:30:00+02:00", "2026-09-07 21:30:00"},
	}
	for _, tt := range tests {
		if got := farmOpsTime(tt.in); got != tt.want {
			t.Errorf("farmOpsTime(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
	if got := farmOpsTime("not-a-time"); len(got) != len(sqliteDatetimeLayout) {
		t.Errorf("farmOpsTime(invalid) = %q, want a fallback timestamp", got)
	}
}

func TestFarmOpsDateOnly(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"2026-09-07T00:00:00.000Z", "2026-09-07"},
		{"2026-09-07T23:59:59Z", "2026-09-07"},
		{"garbage", ""},
		{"", ""},
	}
	for _, tt := range tests {
		if got := farmOpsDateOnly(tt.in); got != tt.want {
			t.Errorf("farmOpsDateOnly(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestFarmOpsParseInt(t *testing.T) {
	tests := []struct {
		in   string
		want int64
	}{
		{"413047163", 413047163},
		{"  7350 ", 7350},
		{"0", 0},
		{"", 0},
		{"12.5", 0},
	}
	for _, tt := range tests {
		if got := farmOpsParseInt(tt.in); got != tt.want {
			t.Errorf("farmOpsParseInt(%q) = %d, want %d", tt.in, got, tt.want)
		}
	}
}

func TestFarmOpsNullInt(t *testing.T) {
	if v := farmOpsNullInt(nil); v != nil {
		t.Errorf("farmOpsNullInt(nil) = %v, want nil", v)
	}
	n := 35
	if v := farmOpsNullInt(&n); v != 35 {
		t.Errorf("farmOpsNullInt(&35) = %v, want 35", v)
	}
}
