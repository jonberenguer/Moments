package main

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// Faithful Go ports of the encoder helpers from electron-app-legacy/electron/
// main.js. The frontend (useFFmpeg.js) builds the FFmpeg arg arrays with the
// tokens __ENCODER__ / __ENC_ARGS__ / __ENC_ARGS_HQ__; StartExport resolves them
// using resolveEncoder + these two arg builders (see export.go). Keep in lockstep
// with the CLAUDE.md "Encoder quality args" / "intermediate args" tables.

// EncoderChoice mirrors resolveEncoder's return.
type EncoderChoice struct {
	Encoder string
	Label   string
	Hw      bool
}

// resolveEncoder picks the encoder from detected caps + an optional override.
func resolveEncoder(caps GPUCaps, override string) EncoderChoice {
	if override != "" && override != "auto" {
		m := map[string]string{
			"nvenc": "h264_nvenc", "amf": "h264_amf", "qsv": "h264_qsv",
			"v4l2m2m": "h264_v4l2m2m", "cpu": "libx264",
		}
		if enc, ok := m[override]; ok {
			return EncoderChoice{Encoder: enc, Label: strings.ToUpper(override), Hw: override != "cpu"}
		}
	}
	switch {
	case caps.Nvenc:
		return EncoderChoice{"h264_nvenc", "NVENC (GPU)", true}
	case caps.Amf:
		return EncoderChoice{"h264_amf", "AMF (GPU)", true}
	case caps.Qsv:
		return EncoderChoice{"h264_qsv", "QSV (iGPU)", true}
	case caps.V4l2m2m:
		return EncoderChoice{"h264_v4l2m2m", "V4L2M2M (HW)", true}
	default:
		return EncoderChoice{"libx264", "CPU (libx264)", false}
	}
}

func pick(m map[string]string, key, def string) string {
	if v, ok := m[key]; ok {
		return v
	}
	return def
}

// encoderQualityArgs — the user-tier final-encode args (CRF/CQ + preset, or capped
// VBR when bitrateMbps > 0). H.264 high profile.
func encoderQualityArgs(encoder, tier string, bitrateMbps float64) []string {
	cqMap := map[string]int{"high": 18, "balanced": 21, "small": 26}
	cq, ok := cqMap[tier]
	if !ok {
		cq = 21
	}
	cqs := strconv.Itoa(cq)
	x264Pre := pick(map[string]string{"high": "slow", "balanced": "medium", "small": "veryfast"}, tier, "medium")
	nvPre := pick(map[string]string{"high": "p6", "balanced": "p4", "small": "p2"}, tier, "p4")
	qsvPre := pick(map[string]string{"high": "slower", "balanced": "medium", "small": "veryfast"}, tier, "medium")
	profile := []string{"-profile:v", "high"}

	br := 0
	if bitrateMbps > 0 {
		br = int(math.Round(bitrateMbps * 1000)) // → kbps
	}
	maxr := 0
	if br > 0 {
		maxr = int(math.Round(float64(br) * 1.45))
	}
	k := func(v int) string { return fmt.Sprintf("%dk", v) }

	switch encoder {
	case "h264_nvenc":
		if br > 0 {
			return append([]string{"-preset", nvPre, "-rc", "vbr", "-b:v", k(br), "-maxrate", k(maxr), "-bufsize", k(br * 2)}, profile...)
		}
		return append([]string{"-preset", nvPre, "-rc", "vbr", "-cq", cqs, "-b:v", "0"}, profile...)
	case "h264_amf":
		if br > 0 {
			return append([]string{"-quality", "balanced", "-rc", "vbr_peak", "-b:v", k(br), "-maxrate", k(maxr)}, profile...)
		}
		q := "balanced"
		if tier == "small" {
			q = "speed"
		}
		return append([]string{"-quality", q, "-rc", "vbr_latency"}, profile...)
	case "h264_qsv":
		if br > 0 {
			return append([]string{"-preset", qsvPre, "-b:v", k(br), "-maxrate", k(maxr)}, profile...)
		}
		return append([]string{"-preset", qsvPre, "-global_quality", cqs}, profile...)
	case "h264_v4l2m2m":
		if br > 0 {
			return []string{"-b:v", k(br)}
		}
		return []string{"-b:v", pick(map[string]string{"high": "8M", "balanced": "6M", "small": "3M"}, tier, "6M")}
	default: // libx264
		if br > 0 {
			return append([]string{"-preset", x264Pre, "-b:v", k(br), "-maxrate", k(maxr), "-bufsize", k(br * 2), "-threads", "0"}, profile...)
		}
		return append([]string{"-preset", x264Pre, "-crf", cqs, "-threads", "0"}, profile...)
	}
}

// encoderIntermediateArgs — near-lossless args for Stage 1–4 intermediates so
// generational loss doesn't compound (the transition-pixelation fix).
func encoderIntermediateArgs(encoder string) []string {
	switch encoder {
	case "h264_nvenc":
		return []string{"-preset", "p5", "-rc", "vbr", "-cq", "16", "-b:v", "0", "-profile:v", "high"}
	case "h264_amf":
		return []string{"-quality", "quality", "-rc", "vbr_peak", "-b:v", "40M", "-maxrate", "60M", "-profile:v", "high"}
	case "h264_qsv":
		return []string{"-preset", "medium", "-global_quality", "16", "-profile:v", "high"}
	case "h264_v4l2m2m":
		return []string{"-b:v", "40M"}
	default: // libx264
		return []string{"-preset", "veryfast", "-crf", "15", "-threads", "0", "-profile:v", "high"}
	}
}
