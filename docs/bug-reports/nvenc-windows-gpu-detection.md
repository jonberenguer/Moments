# Bug: NVENC (NVIDIA) not detected during export on Windows

| | |
|---|---|
| **Status** | Open — investigation paused (no Windows machine on hand) |
| **Severity** | High (forces CPU `libx264` export on NVIDIA Windows machines → much slower) |
| **Platform** | Windows (x64). Linux AppImage not confirmed affected. |
| **Component** | `electron/main.js` → `detectGPUCapabilities()` GPU smoke test |
| **Reported** | 2026-06-12 |
| **Next step** | Run the [Windows troubleshooting checklist](#windows-troubleshooting-checklist) on the affected machine, then apply the [proposed fix](#proposed-fix). |

## Symptom
On Windows, the app does not detect/use the NVIDIA GPU (NVENC) during export; it falls back to CPU (`libx264`). The GPU Selector shows NVENC as unavailable.

## Confirmed during investigation
- **The bundled Windows FFmpeg binary is fine.** `bin/win/ffmpeg.exe` (BtbN GPL build, ~204 MB) is compiled with NVENC/CUDA — build config contains `--enable-ffnvcodec` and `--enable-cuda-llvm`, and `h264_nvenc` is present in the binary. So this is **not** a missing-encoder problem.
- The first detection stage works: `ffmpeg -encoders` finds `h264_nvenc`, so `result.nvenc` starts `true`.
- The failure is in the **runtime 1-frame smoke test** that must pass to keep `nvenc = true`. If it fails, NVENC is flipped back to `false` and export uses CPU.

## Root causes (in the smoke test)

### A. CUDA smoke test places input options after `-i` (definite bug)
`detectGPUCapabilities()` builds the test args as (`smokeTest`, ~`electron/main.js:80`):
```
ffmpeg -f lavfi -i color=black:size=64x64:rate=1 -frames:v 1 \
       -c:v h264_nvenc -hwaccel cuda -hwaccel_output_format cuda -preset p1 -y out.mp4
```
`-hwaccel` / `-hwaccel_output_format` are **per-input options and must appear *before* `-i`**. Placed after the input (output section), FFmpeg treats it as a fatal error ("an input option applied to an output file") → the CUDA test **always exits non-zero** → `result.nvencNeedsCuda` is never set true. The entire "NVENC over RDP / headless / no-display" path (`electron/main.js:94-103`) is therefore dead.

### B. Even if positioned correctly, that test can't pass
`-hwaccel_output_format cuda` forces decoded frames to remain in **GPU memory**, but the `lavfi color` source produces **CPU** frames with no `hwupload` → format mismatch. It tests an impossible pipeline. The correct way to force device init for an *encoder* test is the global `-init_hw_device cuda:0` (before inputs) — not `-hwaccel`, which is for *decoding*.

### C. Diagnostic blind spot — smoke-test stderr is discarded
`smokeTest` spawns with `stdio: 'ignore'` (`electron/main.js:88`), so FFmpeg's error output is thrown away. We can't see *why* NVENC fails. The real reason is hidden and is most likely one of:
- `-preset p1` unsupported by the installed driver (the `p1–p7` presets need a recent NVENC SDK/driver; older drivers want `-preset fast`/`hq`),
- `Cannot load nvcuda.dll` / `No NVENC capable devices found`,
- NVENC session limit reached, or
- a CUDA device-init failure.

### Likely secondary factor on a normal desktop
On a standard Windows machine with a display attached, the **plain** test (`electron/main.js:100`: `-c:v h264_nvenc -preset p1`) should pass. If it doesn't, `-preset p1` is the prime suspect (see C). Confirm via the checklist.

### Related: export-time hwaccel injection
At export, `hwaccelInputArgs = ['-hwaccel','cuda']` is prepended before the first `-i` **only when `caps.nvencNeedsCuda` is true** (`electron/main.js:346-349`, injected at `:421-426`). Because Bug A means `nvencNeedsCuda` is never true, this never fires — and on machines that genuinely need device init at encode time it would also be the wrong mechanism (should be `-init_hw_device cuda`).

## Windows troubleshooting checklist
Run these on the affected machine. Use the bundled exe — in a packaged install it's at `…\resources\ffmpeg\ffmpeg.exe`; in dev it's `bin\win\ffmpeg.exe`. Capture the **full stderr** of each.

1. **Driver / GPU present**
   ```
   nvidia-smi
   ```
   Confirm a driver version (README requires **522+** for NVENC) and that the GPU is listed.

2. **Encoder compiled in**
   ```
   ffmpeg -hide_banner -encoders | findstr nvenc
   ```
   Expect `h264_nvenc`. (Already confirmed present, but re-verify on the deployed copy.)

3. **Plain NVENC encode (this is the app's real gate)**
   ```
   ffmpeg -f lavfi -i color=black:size=64x64:rate=1 -frames:v 1 -c:v h264_nvenc -preset p1 -y out.mp4
   ```
   - If it **succeeds** → detection *should* work; investigate caching / how the app invokes it.
   - If it **fails** → read the error. Then try a more compatible preset:
     ```
     ffmpeg -f lavfi -i color=black:size=64x64:rate=1 -frames:v 1 -c:v h264_nvenc -preset fast -y out.mp4
     ```
     If `fast` works but `p1` doesn't → it's the preset (Bug C / preset).

4. **Forced CUDA device init (correct form of the RDP path)**
   ```
   ffmpeg -init_hw_device cuda:0 -f lavfi -i color=black:size=64x64:rate=1 -frames:v 1 -c:v h264_nvenc -preset p4 -y out.mp4
   ```
   If only this variant works, the machine needs explicit device init.

5. **Record the exact error string** (e.g. `Cannot load nvcuda.dll`, `No NVENC capable devices found`, `OpenEncodeSessionEx failed`, `InitializeEncoder failed`, `Provided ptr is NULL`). That string determines the fix.

## Proposed fix
1. **Make detection diagnosable first.** Replace `stdio: 'ignore'` in `smokeTest` with a piped stderr capture and log it to the export console / main log, so the real NVENC error is visible on the user's machine (addresses Bug C).
2. **Fix the CUDA detection path** (Bugs A & B):
   - Drop `-hwaccel_output_format cuda`.
   - Use `-init_hw_device cuda:0` as a **global option before the inputs**, not `-hwaccel cuda` after `-c:v`.
   - Mirror the same at export time (`hwaccelInputArgs`) instead of the misplaced `-hwaccel cuda`.
3. **Add a preset fallback** so an older driver still passes: try `p4`, then `fast`, before declaring NVENC unavailable.
4. Re-test detection on RDP and on a normal desktop session.

## Code references
- `electron/main.js` — `detectGPUCapabilities()`, `smokeTest()` (~line 46–111)
- CUDA test + `nvencNeedsCuda` (~line 94–103)
- Export hwaccel injection (~line 346–349, 421–426)
- `encoderQualityArgs()` NVENC preset `p2` (~line 131)
