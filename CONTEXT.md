# SoundCheck domain

Terms used across the code, README and UI. The UI text is Traditional Chinese; the term in
parentheses is what the code calls it.

**直播軟體 (streaming software)**: the program that sends the stream, OBS Studio or Streamlabs
Desktop. SoundCheck talks to one at a time through an adapter. UI text says 直播軟體 and only
names the product (`{app}`) in steps that point at its menus.

**Capabilities**: what the connected streaming software lets SoundCheck read and change.
OBS supports everything; Streamlabs only volume, mute, scenes and item visibility.

**音訊來源 (audio source)**: an input in the streaming software that can make sound: a mic, desktop
audio, an app capture, a media or browser source. Identified by its name.

**全域來源 (global source)**: a desktop or mic device added in the streaming software's audio
settings; present in every scene.

**場景 (scene)**: a layout in the streaming software. Contains scene items; an item can be another
scene (nested scene) or a group. The **目前場景 (program scene)** is the one on stream.

**直播音軌 (stream track)**: the audio track(s), 1–6, that the stream output encodes. A source only
reaches viewers if it is sent to a stream track.

**監聽 (monitoring)**: sending a source to the user's headphones. "Monitor only" sends it there
*instead of* the stream; it is not what viewers hear.

**來源狀態 (source status)**: whether viewers can hear a source in the program scene, and if not,
why: hidden, muted, monitor only, not on a stream track, or not in the scene. "Heard" sources are
further split by whether sound is coming in right now (needs level meters).

**外掛 (plugin)**: SoundCheck's own OBS plugin (`soundcheck`). It taps the stream mix and can
pause stream audio; OBS only. Talks to the app through obs-websocket vendor requests.

**直播混音 (stream mix)** and **tap**: the mixed audio of a stream track, copied to the app by the
plugin's tap. Feeds the stream meter and the sound test.

**試音 (sound test)**: record a stretch of the stream mix, then play it back to the user. During
playback the stream tracks are paused so the playback can't reach viewers.

**設定檔 (profile)**: a saved set of every audio source's volume, mute, monitoring, balance, sync
offset, tracks and audio filters, applied back in one go.

**系統聲音 (system audio)**: what is playing on the computer outside the streaming software (apps
and devices from the OS), compared against the software's captures to find sound that viewers
can't hear yet.
