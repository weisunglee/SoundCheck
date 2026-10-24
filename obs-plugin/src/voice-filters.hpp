// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 weisunglee

#pragma once

struct obs_data;
typedef struct obs_data obs_data_t;

/** Registers the "soundcheck_voice_eq" audio filter (voice-eq.cpp). */
void register_voice_eq();

/**
 * Registers the "soundcheck_voice_analyzer" audio filter (voice-analyzer.cpp): it passes audio
 * through untouched, and on request records it as it is before the filters after it. The app
 * puts it first in a source's chain to hear the mic as it really is.
 */
void register_voice_analyzer();

// The requests that drive the analyzer, by the name of the source it is on.
// "StartVoiceCapture" { source, seconds }
void voice_capture_start(obs_data_t *request, obs_data_t *response);
// "ReadVoiceCapture" { source, from }: mono float PCM from frame `from` on, base64 (little-endian).
void voice_capture_read(obs_data_t *request, obs_data_t *response);
// "StopVoiceCapture" { source }: stops recording and drops what was recorded.
void voice_capture_stop(obs_data_t *request, obs_data_t *response);
