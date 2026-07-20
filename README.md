# CapsPulse
<img width="2172" height="724" alt="ChatGPT Image Jul 20, 2026, 08_19_29 PM" src="https://github.com/user-attachments/assets/7117c1e9-89a3-42f2-8ce6-9775427c44a6" />


**See your Pi agent working at a glance.**

CapsPulse turns the built-in MacBook Caps Lock indicator into a physical status light for the [Pi coding agent](https://github.com/earendil-works/pi). The light pulses while the agent is working and glows steadily when Pi is ready.

CapsPulse writes directly to the keyboard's HID LED output. It does not emit keyboard events or change the logical Caps Lock state, so your typing remains unaffected.

## Behavior

| Pi state | Caps Lock light |
| --- | --- |
| Starting or ready | Solid |
| Thinking, using tools, or responding | Pulsing |
| Agent asked a question and is waiting for user input | Fast blinking |
| Agent finished without requesting input | Solid |
| Pi exits or reloads | Restored to the logical Caps Lock state |

## Requirements

- macOS
- A MacBook with a built-in Caps Lock indicator
- [Pi](https://github.com/earendil-works/pi)
- Xcode Command Line Tools (`xcode-select --install`)
- Input Monitoring permission for the terminal application running Pi

## Installation

Install from npm:

```sh
pi install npm:pi-capspulse
```

Or install the latest source directly from GitHub:

```sh
pi install git:github.com/ssk090/CapsPulse
```

Restart Pi or run:

```text
/reload
```

CapsPulse compiles its small native helper locally on first use and caches it under `~/Library/Caches/pi-capspulse/`. This produces the correct binary for both Apple Silicon and Intel Macs.

## macOS permission

Direct HID access requires **Input Monitoring** permission:

1. Open **System Settings → Privacy & Security → Input Monitoring**.
2. Enable the terminal application that runs Pi, such as Terminal, iTerm2, Ghostty, or cmux.
3. Restart that application if macOS requests it.

CapsPulse reports an error in Pi if the built-in LED is unavailable or access is denied.

## Safety and privacy

CapsPulse runs entirely on your Mac. It does not:

- synthesize Caps Lock key presses;
- change capitalization state;
- read or record keystrokes;
- access the network; or
- control the camera privacy indicator.

The helper watches its parent process through standard input. If Pi exits or the helper is terminated, it makes a best-effort restoration of the LED to the current logical Caps Lock state.

## Multiple Pi sessions

When multiple Pi sessions are open, CapsPulse only lets the selected cmux surface drive the LED. That surface remains the owner when another application is opened or macOS is locked, so the light continues to show the state of the last cmux tab you selected. Activity or completion in background tabs cannot replace its LED state.

Outside cmux, CapsPulse uses the frontmost terminal application when focus can be detected. If focus cannot be detected, it falls back to single-session behavior.

## Development

```sh
git clone https://github.com/ssk090/CapsPulse.git
cd CapsPulse
npm install
npm test
pi -e ./index.ts
```

`npm test` runs strict TypeScript checking and warning-free native compilation.

## Publishing

CapsPulse includes the `pi-package` keyword and Pi package manifest required for discovery on the [Pi package gallery](https://pi.dev/packages). Publishing a public npm release makes it eligible for the gallery:

```sh
npm login
npm publish
```

The `prepublishOnly` check prevents publication if TypeScript or native compilation fails.

## License

[MIT](LICENSE)
