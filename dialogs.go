package main

import (
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// MediaEntry mirrors the Electron dialog:openFiles return shape: path descriptors
// only (no bytes) — the frontend renders via the media:// equivalent and export
// copies from path.
type MediaEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Mime string `json:"mime"`
	Size int64  `json:"size"`
}

// FileFilterInput matches the Electron filter shape ({name, extensions}) the
// frontend passes to saveFileDialog.
type FileFilterInput struct {
	Name       string   `json:"name"`
	Extensions []string `json:"extensions"`
}

var videoExts = map[string]bool{
	"mp4": true, "mov": true, "webm": true, "avi": true, "mkv": true, "m4v": true,
}

func mimeFor(ext string) string {
	ext = strings.ToLower(ext)
	if videoExts[ext] {
		if ext == "mov" {
			return "video/quicktime"
		}
		return "video/" + ext
	}
	if ext == "jpg" {
		return "image/jpeg"
	}
	return "image/" + ext
}

// OpenFilesDialog shows a native multi-select open dialog and returns path
// descriptors, persisting the chosen directory as lastMediaDir (like Electron).
func (a *App) OpenFilesDialog(accept string) ([]MediaEntry, error) {
	prefs := readPrefs()
	defaultDir, _ := prefs["lastMediaDir"].(string)
	if defaultDir == "" {
		if home, err := os.UserHomeDir(); err == nil {
			defaultDir = home
		}
	}

	filters := []wruntime.FileFilter{
		{DisplayName: "Media", Pattern: "*.jpg;*.jpeg;*.png;*.gif;*.webp;*.heic;*.avif;*.mp4;*.mov;*.webm;*.avi;*.mkv;*.m4v"},
		{DisplayName: "Images", Pattern: "*.jpg;*.jpeg;*.png;*.gif;*.webp;*.heic;*.avif"},
		{DisplayName: "Videos", Pattern: "*.mp4;*.mov;*.webm;*.avi;*.mkv;*.m4v"},
		{DisplayName: "All Files", Pattern: "*.*"},
	}

	paths, err := wruntime.OpenMultipleFilesDialog(a.ctx, wruntime.OpenDialogOptions{
		Title:            "Add Media",
		DefaultDirectory: defaultDir,
		Filters:          filters,
	})
	if err != nil {
		return nil, err
	}
	if len(paths) == 0 {
		return []MediaEntry{}, nil
	}

	// Persist the directory of the first pick for next time.
	prefs["lastMediaDir"] = filepath.Dir(paths[0])
	writePrefs(prefs)

	out := make([]MediaEntry, 0, len(paths))
	for _, fp := range paths {
		ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(fp)), ".")
		var size int64
		if fi, err := os.Stat(fp); err == nil {
			size = fi.Size()
		}
		out = append(out, MediaEntry{
			Name: filepath.Base(fp),
			Path: fp,
			Mime: mimeFor(ext),
			Size: size,
		})
	}
	return out, nil
}

// SaveFileDialog shows a native save dialog and returns the chosen path, or an
// empty string when cancelled (the shim maps "" → null to match Electron).
func (a *App) SaveFileDialog(defaultName string, filters []FileFilterInput) (string, error) {
	if defaultName == "" {
		defaultName = "moment.mp4"
	}
	wf := make([]wruntime.FileFilter, 0, len(filters))
	for _, f := range filters {
		pats := make([]string, 0, len(f.Extensions))
		for _, e := range f.Extensions {
			pats = append(pats, "*."+e)
		}
		wf = append(wf, wruntime.FileFilter{DisplayName: f.Name, Pattern: strings.Join(pats, ";")})
	}
	if len(wf) == 0 {
		wf = []wruntime.FileFilter{{DisplayName: "MP4 Video", Pattern: "*.mp4"}}
	}
	return wruntime.SaveFileDialog(a.ctx, wruntime.SaveDialogOptions{
		DefaultFilename: defaultName,
		Filters:         wf,
	})
}

// OpenPath opens a file/dir in the OS default handler (Electron shell.openPath).
// Returns "" on success or an error string, matching shell.openPath.
func (a *App) OpenPath(path string) string {
	var cmd *exec.Cmd
	switch goruntime.GOOS {
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", "", path)
	case "darwin":
		cmd = exec.Command("open", path)
	default:
		cmd = exec.Command("xdg-open", path)
	}
	if err := cmd.Start(); err != nil {
		return err.Error()
	}
	return ""
}
