# Centre de Contrôle — Cinnamon applet

An all-in-one panel applet for the Cinnamon desktop, replacing the stock clock with a
single control surface.

- **Header** — long date, plus shortcuts to System Settings, screen lock and power off.
- **Quick toggles** — Wi-Fi (with the connected SSID), Bluetooth, Night Light, Do Not Disturb.
- **Power profiles** — Eco / Balanced / Performance, through `powerprofilesctl`.
- **Sliders** — output volume with mute, and screen brightness (hardware backlight when
  available, `xrandr` otherwise).
- **Tabs** — calendar with real events from Evolution Data Server plus a per-calendar
  picker, notification history, and a de-duplicated view of recent system errors from the
  journal.

## Installation

```bash
git clone git@github.com:qaqamzmz/cinnamon-control-center-applet.git
ln -s "$PWD/cinnamon-control-center-applet/files/control-center@qaqamzmz" \
      ~/.local/share/cinnamon/applets/control-center@qaqamzmz
```

Or copy instead of symlinking:

```bash
cp -r files/control-center@qaqamzmz ~/.local/share/cinnamon/applets/
```

Then add the applet from *System Settings → Applets*, or with `cinnamon-settings applets`.

## External calendars (Google, Nextcloud, Microsoft…)

The calendar tab does **not** talk to any cloud service itself. It reads
`org.cinnamon.CalendarServer`, which is a client of **Evolution Data Server**. Adding an
account therefore happens once, at the system level, and every EDS-aware application
benefits from it:

```bash
gnome-online-accounts-gtk        # add the account, tick "Calendar"
```

Which calendars are displayed is controlled by the `Selected` flag Evolution Data Server
keeps for each source. The calendar tab lists every calendar it finds, with a dot in the
colour EDS stores for it, and clicking a row toggles that flag — the same thing the GNOME
Calendar sidebar does. A shortcut to Online Accounts sits next to the list, and the applet
settings hold the same two shortcuts.

This delegation is deliberate: implementing OAuth inside an applet would mean shipping a
client secret in a world-readable JavaScript file and handling token storage by hand.

The source registry is opened asynchronously — `new_sync()` would block the whole Cinnamon
process while D-Bus answers — and the applet listens to `source-added`, `source-removed`,
`source-changed`, `source-enabled` and `source-disabled` so the list follows accounts being
added or removed elsewhere. If the `EDataServer` typelib is missing, the picker is replaced
by a single line saying so and the rest of the applet is unaffected.

## Requirements

| Feature | Needs |
| --- | --- |
| Calendar events | `evolution-data-server` (ships with Cinnamon) |
| External calendars | `gnome-online-accounts` |
| Power profiles | `power-profiles-daemon` (`powerprofilesctl`) |
| Wi-Fi toggle | NetworkManager (`nmcli`) |
| Bluetooth toggle | `bluez` (`bluetoothctl`) + `rfkill` |
| Volume | PulseAudio or PipeWire (`pactl`) |
| Brightness fallback | `xrandr` |

A missing optional dependency degrades the matching tile; it does not break the applet.

## Compatibility

`cinnamon-version` declares 6.0 through 6.6, but **only Cinnamon 6.6.9 has actually been
tested**. Earlier 6.x releases are expected to work — the applet relies on
`Cinnamon.CalendarServerProxy`, which predates 6.6 — but this is untested. Reports welcome.

## Known limitations

- The interface is **French only**. Strings in `applet.js` are hardcoded; there is no `po/`
  directory yet. Contributions towards `gettext` are welcome.
- The date format is fixed and not yet configurable.

## Credits

- `calendar.js`, `eventView.js` and `settings-schema.json` come from the
  `calendar@cinnamon.org` applet of [linuxmint/cinnamon](https://github.com/linuxmint/cinnamon),
  licensed GPL-2.0-or-later. They are vendored because they live inside that applet's
  directory and are not reachable through the `imports.ui` search path. The only change is
  exporting the top-level classes so `require()` can pull them in — diff against upstream
  before editing, and keep them in sync when Cinnamon updates.
- `applet.js` and `stylesheet.css` are written for this project, with AI assistance under
  human supervision.
- The visual design matches the
  [Adapta-Nokto-Agy](https://github.com/qaqamzmz/Adapta-Nokto-Agy) theme.

## License

GPL-2.0-or-later, inherited from the Cinnamon code this applet builds on. See [LICENSE](LICENSE).
