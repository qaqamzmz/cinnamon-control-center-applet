# Centre de Contrôle — Cinnamon applet

> 🌐 **Navigation rapide / Quick navigation** : [🇫🇷 Guide d'installation (FR)](#guide-dinstallation-sur-un-poste-utilisateur-fr) · [🇬🇧 Installation Guide (EN)](#user-workstation-installation-guide-en) · [📅 External Calendars](#external-calendars-google-nextcloud-microsoft) · [📦 Requirements](#requirements) · [⚖️ License](#license)

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

## Guide d'installation sur un poste utilisateur (FR)

> 🇬🇧 *Looking for the English version? Jump to the [User Workstation Installation Guide (EN)](#user-workstation-installation-guide-en).*

### 1. Prérequis système

Sur Linux Mint, Debian ou Ubuntu avec le bureau **Cinnamon (6.0 à 6.6)**, vérifiez que les utilitaires système optionnels sont installés pour profiter de toutes les fonctionnalités du Centre de Contrôle :

```bash
sudo apt update
sudo apt install -y \
  gir1.2-edataserver-1.2 \
  evolution-data-server \
  gnome-online-accounts-gtk \
  gnome-calendar \
  power-profiles-daemon \
  network-manager \
  bluez \
  rfkill \
  pulseaudio-utils \
  x11-xserver-utils
```

### 2. Téléchargement et installation de l'applet

Créez le dossier des applets Cinnamon de l'utilisateur s'il n'existe pas encore, puis copiez-y (ou liez) l'applet :

#### Option A — Copie directe (recommandé pour un poste utilisateur)

```bash
mkdir -p ~/.local/share/cinnamon/applets
git clone https://github.com/qaqamzmz/cinnamon-control-center-applet.git /tmp/cinnamon-control-center-applet
cp -r /tmp/cinnamon-control-center-applet/files/control-center@qaqamzmz ~/.local/share/cinnamon/applets/
rm -rf /tmp/cinnamon-control-center-applet
```

#### Option B — Lien symbolique (recommandé pour les développeurs / mises à jour via `git pull`)

```bash
mkdir -p ~/.local/share/cinnamon/applets
git clone https://github.com/qaqamzmz/cinnamon-control-center-applet.git ~/cinnamon-control-center-applet
ln -s "$HOME/cinnamon-control-center-applet/files/control-center@qaqamzmz" \
      ~/.local/share/cinnamon/applets/control-center@qaqamzmz
```

### 3. Activation dans le tableau de bord Cinnamon

1. Effectuez un **clic droit** sur votre tableau de bord Cinnamon → **Applets** (ou lancez `cinnamon-settings applets` depuis un terminal).
2. Dans l'onglet **Gérer**, recherchez **Centre de Contrôle** (`control-center@qaqamzmz`).
3. Sélectionnez-le puis cliquez sur le bouton **`+`** en bas de la fenêtre pour l'ajouter au panneau.
4. *(Optionnel)* Vous pouvez retirer l'applet d'horloge par défaut (`calendar@cinnamon.org`) puisque le **Centre de Contrôle** affiche déjà l'heure dans la barre et intègre l'agenda complet.
5. Si vous mettez à jour les fichiers de l'applet ultérieurement, rechargez Cinnamon avec `Alt+F2` puis `r` (Entrée) ou via :
   ```bash
   dbus-send --session --dest=org.Cinnamon --type=method_call /org/Cinnamon org.Cinnamon.Eval string:'Main.AppletManager.reload_applet_by_uuid("control-center@qaqamzmz");'
   ```

### 4. Synchronisation des calendriers externes (Google, Nextcloud, Microsoft…)

1. Cliquez sur l'applet **Centre de Contrôle** → onglet **📅 Agenda** → bouton **`+ Compte en ligne`** (ou lancez `gnome-online-accounts-gtk`).
2. Connectez votre compte et assurez-vous que l'option **Calendrier / Agenda** est activée.
3. Les calendriers synchronisés apparaissent automatiquement dans la section **Calendriers** de l'applet : cliquez sur une ligne pour afficher ou masquer ses événements.

### 5. Désinstallation

Retirez l'applet depuis `cinnamon-settings applets`, puis supprimez son dossier :

```bash
rm -rf ~/.local/share/cinnamon/applets/control-center@qaqamzmz
```

---

## User Workstation Installation Guide (EN)

> 🇫🇷 *Vous cherchez la version française ? Consultez le [Guide d'installation sur un poste utilisateur (FR)](#guide-dinstallation-sur-un-poste-utilisateur-fr).*

### 1. System Prerequisites

On Linux Mint, Debian, or Ubuntu running the **Cinnamon desktop (6.0 to 6.6)**, ensure the optional system utilities are installed to take advantage of every Control Center feature:

```bash
sudo apt update
sudo apt install -y \
  gir1.2-edataserver-1.2 \
  evolution-data-server \
  gnome-online-accounts-gtk \
  gnome-calendar \
  power-profiles-daemon \
  network-manager \
  bluez \
  rfkill \
  pulseaudio-utils \
  x11-xserver-utils
```

### 2. Downloading and Installing the Applet

Create your user Cinnamon applets directory if it does not already exist, then copy (or symlink) the applet into it:

#### Option A — Direct Copy (recommended for end-user workstations)

```bash
mkdir -p ~/.local/share/cinnamon/applets
git clone https://github.com/qaqamzmz/cinnamon-control-center-applet.git /tmp/cinnamon-control-center-applet
cp -r /tmp/cinnamon-control-center-applet/files/control-center@qaqamzmz ~/.local/share/cinnamon/applets/
rm -rf /tmp/cinnamon-control-center-applet
```

#### Option B — Symbolic Link (recommended for developers / updating via `git pull`)

```bash
mkdir -p ~/.local/share/cinnamon/applets
git clone https://github.com/qaqamzmz/cinnamon-control-center-applet.git ~/cinnamon-control-center-applet
ln -s "$HOME/cinnamon-control-center-applet/files/control-center@qaqamzmz" \
      ~/.local/share/cinnamon/applets/control-center@qaqamzmz
```

### 3. Enabling the Applet in the Cinnamon Panel

1. **Right-click** on your Cinnamon panel → **Applets** (or run `cinnamon-settings applets` in a terminal).
2. In the **Manage** tab, search for **Centre de Contrôle** (`control-center@qaqamzmz`).
3. Select it and click the **`+`** button at the bottom of the window to add it to your panel.
4. *(Optional)* You can remove the stock clock applet (`calendar@cinnamon.org`) since **Centre de Contrôle** already displays the time in the panel and integrates the full calendar view.
5. If you update the applet files later, reload Cinnamon with `Alt+F2` then `r` (Enter), or via D-Bus:
   ```bash
   dbus-send --session --dest=org.Cinnamon --type=method_call /org/Cinnamon org.Cinnamon.Eval string:'Main.AppletManager.reload_applet_by_uuid("control-center@qaqamzmz");'
   ```

### 4. Synchronizing External Calendars (Google, Nextcloud, Microsoft…)

1. Click the **Centre de Contrôle** applet → **📅 Agenda** tab → **`+ Compte en ligne`** button (or run `gnome-online-accounts-gtk`).
2. Sign in to your online account and make sure the **Calendar** switch is enabled.
3. Synchronized calendars automatically appear under the **Calendriers** section of the applet: click any row to show or hide its events.

### 5. Uninstallation

Remove the applet from `cinnamon-settings applets`, then delete its directory:

```bash
rm -rf ~/.local/share/cinnamon/applets/control-center@qaqamzmz
```

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

`GPL-3.0-or-later` (GNU General Public License v3.0 or later), compatible with the upstream `GPL-2.0-or-later` Cinnamon code this applet builds on. See [LICENSE](LICENSE).
