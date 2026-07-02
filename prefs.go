package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Persistent preferences — a flat JSON file in the OS user-config dir, matching
// the location:
//   Linux:   ~/.config/moments-app/prefs.json
//   Windows: %APPDATA%\moments-app\prefs.json
// (os.UserConfigDir returns ~/.config and %AppData% respectively.)

func prefsPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = os.TempDir()
	}
	return filepath.Join(dir, "moments-app", "prefs.json")
}

func readPrefs() map[string]interface{} {
	prefs := map[string]interface{}{}
	data, err := os.ReadFile(prefsPath())
	if err != nil {
		return prefs
	}
	_ = json.Unmarshal(data, &prefs) // best-effort; corrupt file → empty prefs
	return prefs
}

func writePrefs(prefs map[string]interface{}) {
	p := prefsPath()
	_ = os.MkdirAll(filepath.Dir(p), 0o755)
	if data, err := json.MarshalIndent(prefs, "", "  "); err == nil {
		_ = os.WriteFile(p, data, 0o644)
	}
}

// GetPrefs returns prefs[key], or the whole prefs map when key is empty. A
// missing key resolves to null (nil).
func (a *App) GetPrefs(key string) interface{} {
	prefs := readPrefs()
	if key == "" {
		return prefs
	}
	if v, ok := prefs[key]; ok {
		return v
	}
	return nil
}

// SetPrefs writes a single key and returns true.
func (a *App) SetPrefs(key string, value interface{}) bool {
	prefs := readPrefs()
	prefs[key] = value
	writePrefs(prefs)
	return true
}
