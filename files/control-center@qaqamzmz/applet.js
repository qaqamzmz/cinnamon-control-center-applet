/*
 * Control Center applet for the Cinnamon desktop.
 *
 * Copyright (C) 2026 qaqamzmz <dev@abourame.com>
 *
 * Developed with AI assistance under human supervision.
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation; either version 3 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License for
 * more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program; if not, see <https://www.gnu.org/licenses/>.
 */

const Applet = imports.ui.applet;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Clutter = imports.gi.Clutter;
const St = imports.gi.St;
const Pango = imports.gi.Pango;
const Util = imports.misc.util;
const PopupMenu = imports.ui.popupMenu;
const CinnamonDesktop = imports.gi.CinnamonDesktop;
const Main = imports.ui.main;
const Settings = imports.ui.settings;
const ByteArray = imports.byteArray;

// Evolution Data Server, used only to list the calendars and flip their "Selected" flag.
// Optional: if the typelib is missing the calendar picker is simply not shown.
let EDataServer = null;
try {
    imports.gi.versions.EDataServer = '1.2';
    EDataServer = imports.gi.EDataServer;
} catch (e) {
    EDataServer = null;
}

// Load Calendar modules from local directory
const Calendar = require('./calendar');
const EventView = require('./eventView');

// ─── Security & Command Helpers ──────────────────────────────────────────────

/**
 * Allowed power profile identifiers accepted by `powerprofilesctl set`.
 * Used as an explicit allowlist before spawning any subprocess.
 */
const ALLOWED_POWER_PROFILES = ['power-saver', 'balanced', 'performance'];

/**
 * Strictly validates a CSS color string originating from an external source
 * (such as Evolution Data Server / remote CalDAV metadata) before injecting
 * it into an inline Clutter/St style attribute.
 *
 * Accepts `#RGB`, `#RRGGBB`, `#RRGGBBAA`, `rgb(...)`, `rgba(...)`, or simple
 * alphabetic color keywords. Rejects anything containing semicolons, quotes,
 * parentheses outside rgb/rgba, or URLs to prevent CSS injection.
 *
 * @param {string} rawColor - Raw color string from EDS
 * @returns {string} The validated color string, or '' if invalid
 */
function sanitizeCssColor(rawColor) {
    if (typeof rawColor !== 'string') return '';
    let trimmed = rawColor.trim();
    if (/^(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,20}|rgba?\([0-9,\s.]{5,30}\))$/.test(trimmed)) {
        return trimmed;
    }
    return '';
}

// ─── Synchronous command runner (GJS/SpiderMonkey safe) ──────────────────────
/**
 * Executes a static read-only command synchronously and returns its trimmed stdout.
 *
 * Security note: `GLib.spawn_command_line_sync` parses the command string with
 * `g_shell_parse_argv` (no `/bin/sh` subshell is invoked, so shell metacharacters
 * like `;`, `|`, `&&`, `$()` are not interpreted). However, callers MUST only
 * pass fixed command strings without untrusted user input.
 *
 * Performance note: Because Cinnamon applets run on the compositor's main GLib
 * loop, this helper should only be used for fast local queries when the popup
 * opens or refreshes.
 *
 * @param {string} command - Static command line to execute
 * @returns {string} Trimmed standard output, or '' on error
 */
function runCmd(command) {
    try {
        let [res, out] = GLib.spawn_command_line_sync(command);
        if (!res || !out || out.length === 0) return '';
        return ByteArray.toString(out).trim();
    } catch (e) {
        global.logError('[ControlCenter] runCmd error: ' + e);
        return '';
    }
}

// ─── Applet ───────────────────────────────────────────────────────────────────
/**
 * Main Control Center applet class for the Cinnamon panel.
 * Displays the current clock in the panel and opens a unified control surface
 * containing quick toggles, power profiles, audio/brightness sliders, calendar
 * with EDS event integration, notification history, and systemd journal errors.
 */
class CinnamonControlCenterApplet extends Applet.TextIconApplet {
    constructor(metadata, orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);
        this.setAllowedLayout(Applet.AllowedLayout.BOTH);
        this.metadata = metadata;
        this.orientation = orientation;
        this.instance_id = instance_id;

        try {
            // Popup menu attached to the panel applet actor
            this.menuManager = new PopupMenu.PopupMenuManager(this);
            this.menu = new Applet.AppletPopupMenu(this, orientation);
            this.menuManager.addMenu(this.menu);
            this.menu.setCustomStyleClass('control-center-popup');

            // System-wide GSettings schemas we read/toggle directly (no shell commands needed)
            this.desktop_settings = new Gio.Settings({ schema_id: 'org.cinnamon.desktop.interface' });
            this.color_settings   = new Gio.Settings({ schema_id: 'org.cinnamon.settings-daemon.plugins.color' });
            this.notif_settings   = new Gio.Settings({ schema_id: 'org.cinnamon.desktop.notifications' });

            // Applet settings, backed by settings-schema.json.
            // These used to be a hardcoded stand-in object, which meant the settings window
            // Cinnamon renders from the schema had no effect at all. AppletSettings already
            // exposes getValue / setValue / bind / bindWithObject -- exactly the interface the
            // vendored calendar.js and eventView.js expect -- so it can be handed to them
            // directly.
            this.settings = new Settings.AppletSettings(this, metadata.uuid, instance_id);
            this.settings.bind('show-events', 'show_events', () => this._refreshCalendar());
            this.settings.bind('show-week-numbers', 'show_week_numbers', () => this._refreshCalendar());
            this.cal_settings = this.settings;

            // Calendar picker (see _initCalendarSources)
            this._source_registry = null;
            this._registry_signal_ids = [];
            this._initCalendarSources();

            // Panel WallClock (updates the panel label every minute/second per user desktop settings)
            this.clock = new CinnamonDesktop.WallClock();
            this.clock_notify_id = this.clock.connect('notify::clock', this._updateClock.bind(this));
            this._updateClock();

            this.set_applet_tooltip('Centre de Contrôle');

            // Build popup UI sections
            this._buildPopup();

            // Notifications store and signal listener (cleaned up on applet removal)
            this.notifications = [];
            this._notif_signal_id = 0;
            if (Main.messageTray) {
                this._notif_signal_id = Main.messageTray.connect(
                    'notify-applet-update',
                    this._onNotificationUpdate.bind(this)
                );
            }

            // First refresh once actors are realized in the Clutter scene
            this._init_timeout_id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
                this._init_timeout_id = 0;
                this._refreshAllStates();
                this._refreshCalendar();
                return GLib.SOURCE_REMOVE;
            });

            // Refresh all hardware/system states whenever the popup menu is opened
            this.menu.connect('open-state-changed', (menu, isOpen) => {
                if (isOpen) {
                    this._refreshAllStates();
                    this._refreshCalendar();
                    this._refreshCalendarSources();
                }
            });

        } catch (e) {
            global.logError('[ControlCenter] Constructor error: ' + e + '\nStack: ' + e.stack);
        }
    }

    /**
     * Synchronizes the panel button label with `CinnamonDesktop.WallClock`.
     */
    _updateClock() {
        if (!this.clock) return;
        this.set_applet_label(this.clock.get_clock());
    }

    /**
     * Toggles the popup menu when the user clicks the panel applet.
     * Note: `_refreshAllStates()` and `_refreshCalendar()` are triggered by the
     * menu's `open-state-changed` signal when opening, avoiding duplicate blocking
     * calls on click or unnecessary refreshes when closing.
     */
    on_applet_clicked(event) {
        this.menu.toggle();
    }

    /**
     * Releases all GObject signals, timers, and settings bindings when the applet
     * is removed from the panel or reloaded, preventing memory leaks and dangling callbacks.
     */
    on_applet_removed_from_panel() {
        if (this._init_timeout_id > 0) {
            GLib.source_remove(this._init_timeout_id);
            this._init_timeout_id = 0;
        }
        if (this.clock && this.clock_notify_id > 0) {
            this.clock.disconnect(this.clock_notify_id);
            this.clock_notify_id = 0;
        }
        if (Main.messageTray && this._notif_signal_id > 0) {
            try { Main.messageTray.disconnect(this._notif_signal_id); } catch (e) {}
            this._notif_signal_id = 0;
        }
        if (this.settings) {
            this.settings.finalize();
            this.settings = null;
        }
        if (this._source_registry) {
            this._registry_signal_ids.forEach((id) => {
                try { this._source_registry.disconnect(id); } catch (e) {}
            });
            this._registry_signal_ids = [];
            this._source_registry = null;
        }
    }

    // ── Settings callbacks ─────────────────────────────────────────────────────
    // Adding an online account is delegated to GNOME Online Accounts on purpose: the
    // calendar tab reads org.cinnamon.CalendarServer, itself a client of Evolution Data
    // Server, so any account registered with GOA shows up with no code of our own. Doing
    // OAuth here would mean shipping a client secret in a world-readable file.
    on_online_accounts_pressed() {
        Util.spawnCommandLine('gnome-online-accounts-gtk');
    }

    // Which calendars are shown is the `Selected` flag Evolution Data Server keeps per
    // source; the GNOME Calendar sidebar is the supported way to toggle it.
    on_manage_calendars_pressed() {
        Util.spawnCommandLine('gnome-calendar');
    }

    // ── Calendar picker ────────────────────────────────────────────────────────
    // Which calendars the applet shows is not ours to decide: cinnamon-calendar-server
    // only serves sources whose Evolution Data Server "Selected" flag is set. So the
    // picker below reads the EDS source registry and flips that flag -- the same thing
    // the GNOME Calendar sidebar does. Accounts themselves stay GNOME Online Accounts'
    // business.
    //
    // The registry is created asynchronously on purpose: new_sync() would block the
    // whole Cinnamon process while D-Bus answers.
    _initCalendarSources() {
        if (!EDataServer) return;
        try {
            EDataServer.SourceRegistry.new(null, (obj, res) => {
                try {
                    this._source_registry = EDataServer.SourceRegistry.new_finish(res);
                    ['source-added', 'source-removed', 'source-changed',
                     'source-enabled', 'source-disabled'].forEach((sig) => {
                        this._registry_signal_ids.push(
                            this._source_registry.connect(sig, () => this._refreshCalendarSources())
                        );
                    });
                    this._refreshCalendarSources();
                } catch (e) {
                    global.logError('[ControlCenter] EDS registry unavailable: ' + e);
                }
            });
        } catch (e) {
            global.logError('[ControlCenter] EDS registry request failed: ' + e);
        }
    }

    _listCalendarSources() {
        if (!this._source_registry || !EDataServer) return [];
        try {
            return this._source_registry
                .list_sources(EDataServer.SOURCE_EXTENSION_CALENDAR)
                .filter((src) => src.get_enabled());
        } catch (e) {
            global.logError('[ControlCenter] Cannot list calendars: ' + e);
            return [];
        }
    }

    _refreshCalendarSources() {
        if (!this.calSourcesBox) return;
        this.calSourcesBox.destroy_all_children();

        let sources = this._listCalendarSources();
        if (sources.length === 0) {
            this.calSourcesBox.add_actor(new St.Label({
                style_class: 'cc-cal-source-empty',
                text: EDataServer ? 'Aucun calendrier détecté'
                                  : 'Evolution Data Server indisponible'
            }));
            return;
        }

        sources.forEach((source) => {
            let ext = source.get_extension(EDataServer.SOURCE_EXTENSION_CALENDAR);
            let selected = ext.get_selected();

            let row = new St.Button({
                style_class: selected ? 'cc-cal-source-row active' : 'cc-cal-source-row',
                reactive: true,
                track_hover: true,
                x_align: St.Align.START
            });
            let content = new St.BoxLayout({ vertical: false, style_class: 'cc-cal-source-content' });
            row.set_child(content);

            // Dot in the calendar's own colour, straight from EDS (sanitized against CSS injection).
            let dot = new St.Bin({ style_class: 'cc-cal-source-dot' });
            let colour = '';
            try { colour = sanitizeCssColor(ext.get_color() || ''); } catch (e) {}
            if (colour) dot.set_style('background-color: ' + colour + ';');
            content.add_actor(dot);

            content.add(new St.Label({
                style_class: 'cc-cal-source-label',
                text: source.get_display_name()
            }), { expand: true });

            content.add_actor(new St.Label({
                style_class: 'cc-cal-source-check',
                text: selected ? '\u2713' : ''
            }));

            row.connect('clicked', () => this._toggleCalendarSource(source));
            this.calSourcesBox.add_actor(row);
        });
    }

    /**
     * Toggles the `Selected` property of an Evolution Data Server calendar source
     * and persists the change asynchronously via `source.write()`.
     *
     * @param {EDataServer.Source} source - The calendar source to toggle
     */
    _toggleCalendarSource(source) {
        if (!EDataServer) return;
        try {
            let ext = source.get_extension(EDataServer.SOURCE_EXTENSION_CALENDAR);
            ext.set_selected(!ext.get_selected());
            // Persist to the EDS source file; the calendar server watches the registry
            // and picks the change up on its own.
            source.write(null, (obj, res) => {
                try {
                    source.write_finish(res);
                } catch (e) {
                    global.logError('[ControlCenter] Cannot save calendar selection: ' + e);
                }
                this._refreshCalendarSources();
                this._refreshCalendar();
            });
        } catch (e) {
            global.logError('[ControlCenter] Cannot toggle calendar: ' + e);
        }
    }

    // ── Build popup ────────────────────────────────────────────────────────────
    /**
     * Assembles all visual sections of the Control Center popup menu.
     */
    _buildPopup() {
        this.mainBox = new St.BoxLayout({ style_class: 'control-center-main-box', vertical: true });
        this.menu.addActor(this.mainBox);

        this._buildHeader();
        this._buildQuickToggles();
        this._buildPowerModes();
        this._buildVolumeSlider();
        this._buildBrightnessSlider();
        this._buildTabs();
    }

    /**
     * Builds the top header bar displaying the current formatted date and
     * quick action buttons (System Settings, Screen Lock, Power Off dialog).
     */
    _buildHeader() {
        let box = new St.BoxLayout({ style_class: 'cc-header-box', vertical: false });
        this.mainBox.add_actor(box);

        this.headerDateLabel = new St.Label({
            style_class: 'cc-header-date-label',
            text: this._formatDate(),
            y_align: Clutter.ActorAlign.CENTER
        });
        box.add(this.headerDateLabel, { expand: true, x_align: St.Align.START });

        let actions = new St.BoxLayout({ style_class: 'cc-header-actions', vertical: false });
        box.add(actions, { expand: false, x_align: St.Align.END });

        actions.add_actor(this._mkIconBtn('preferences-system-symbolic', () => {
            this.menu.close(); Util.spawnCommandLine('cinnamon-settings');
        }));
        actions.add_actor(this._mkIconBtn('changes-prevent-symbolic', () => {
            this.menu.close(); Util.spawnCommandLine('cinnamon-screensaver-command --lock');
        }));
        let pwrBtn = this._mkIconBtn('system-shutdown-symbolic', () => {
            this.menu.close(); Util.spawnCommandLine('cinnamon-session-quit --power-off');
        });
        pwrBtn.add_style_class_name('cc-btn-power');
        actions.add_actor(pwrBtn);
    }

    /**
     * Helper to create a circular symbolic icon button for the header bar.
     */
    _mkIconBtn(iconName, cb) {
        let btn = new St.Button({ style_class: 'cc-icon-action-btn', reactive: true, track_hover: true });
        btn.set_child(new St.Icon({ icon_name: iconName, icon_type: St.IconType.SYMBOLIC, icon_size: 16 }));
        btn.connect('clicked', cb);
        return btn;
    }

    /**
     * Formats the current date in French long format (e.g., "Dimanche 8 novembre 2026").
     */
    _formatDate() {
        let now = new Date();
        let s = now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    /**
     * Builds the 2x2 grid of quick toggle cards: Wi-Fi, Bluetooth, Night Light, and Do Not Disturb.
     */
    _buildQuickToggles() {
        let grid = new St.BoxLayout({ style_class: 'cc-toggles-container', vertical: true });
        this.mainBox.add_actor(grid);

        let row1 = new St.BoxLayout({ style_class: 'cc-toggles-row', vertical: false });
        grid.add_actor(row1);
        this.wifiToggle = this._mkToggleCard('network-wireless-symbolic', 'Wi-Fi', () => this._toggleWifi());
        row1.add(this.wifiToggle.actor, { expand: true, x_fill: true, y_fill: true });
        this.btToggle = this._mkToggleCard('bluetooth-active-symbolic', 'Bluetooth', () => this._toggleBluetooth());
        row1.add(this.btToggle.actor, { expand: true, x_fill: true, y_fill: true });

        let row2 = new St.BoxLayout({ style_class: 'cc-toggles-row', vertical: false });
        grid.add_actor(row2);
        this.nightToggle = this._mkToggleCard('night-light-symbolic', 'Mode Nuit', () => this._toggleNightLight());
        row2.add(this.nightToggle.actor, { expand: true, x_fill: true, y_fill: true });
        this.dndToggle = this._mkToggleCard('notifications-disabled-symbolic', 'Ne pas deranger', () => this._toggleDnd());
        row2.add(this.dndToggle.actor, { expand: true, x_fill: true, y_fill: true });
    }

    /**
     * Creates a reusable toggle card widget with an icon, title, and status subtitle.
     */
    _mkToggleCard(iconName, title, cb) {
        let btn = new St.Button({
            style_class: 'cc-toggle-card', reactive: true, track_hover: true, x_fill: true, y_fill: true
        });
        let box = new St.BoxLayout({ style_class: 'cc-toggle-card-box', vertical: false });
        btn.set_child(box);

        let icon = new St.Icon({ icon_name: iconName, icon_type: St.IconType.SYMBOLIC, icon_size: 20, style_class: 'cc-toggle-icon' });
        box.add_actor(icon);

        let textCol = new St.BoxLayout({ style_class: 'cc-toggle-text-col', vertical: true });
        box.add(textCol, { expand: true, x_fill: true });

        let titleLbl = new St.Label({ style_class: 'cc-toggle-title', text: title });
        if (titleLbl.clutter_text) { titleLbl.clutter_text.set_ellipsize(Pango.EllipsizeMode.END); titleLbl.clutter_text.set_line_wrap(false); }
        textCol.add_actor(titleLbl);

        let subLbl = new St.Label({ style_class: 'cc-toggle-sub', text: 'Desactive' });
        if (subLbl.clutter_text) { subLbl.clutter_text.set_ellipsize(Pango.EllipsizeMode.END); subLbl.clutter_text.set_line_wrap(false); }
        textCol.add_actor(subLbl);

        btn.connect('clicked', cb);

        return {
            actor: btn, icon: icon, subLbl: subLbl, active: false,
            setActive(active, text) {
                this.active = active;
                btn.style_class = active ? 'cc-toggle-card active' : 'cc-toggle-card';
                icon.style_class = active ? 'cc-toggle-icon active' : 'cc-toggle-icon';
                if (text !== undefined) subLbl.set_text(text);
            }
        };
    }

    /**
     * Builds the Power Profiles selector (Eco / Balanced / Performance) backed by `powerprofilesctl`.
     */
    _buildPowerModes() {
        let box = new St.BoxLayout({ style_class: 'cc-section-container', vertical: true });
        this.mainBox.add_actor(box);
        box.add_actor(new St.Label({ style_class: 'cc-section-title', text: "Mode d'Alimentation" }));

        let row = new St.BoxLayout({ style_class: 'cc-power-modes-row', vertical: false });
        box.add_actor(row);

        this.powerButtons = {};
        [['power-saver', 'Eco'], ['balanced', 'Equilibre'], ['performance', 'Performance']].forEach(([id, label]) => {
            let btn = new St.Button({ style_class: 'cc-power-mode-btn', reactive: true, track_hover: true, x_fill: true });
            btn.set_child(new St.Label({ text: label, style_class: 'cc-power-mode-label' }));
            btn.connect('clicked', () => this._setPowerMode(id));
            row.add(btn, { expand: true, x_fill: true });
            this.powerButtons[id] = btn;
        });
    }

    /**
     * Builds the master audio output volume slider and mute toggle button (via `pactl`).
     */
    _buildVolumeSlider() {
        let box = new St.BoxLayout({ style_class: 'cc-section-container', vertical: true });
        this.mainBox.add_actor(box);

        let titleRow = new St.BoxLayout({ vertical: false });
        box.add_actor(titleRow);
        titleRow.add(new St.Label({ style_class: 'cc-section-title', text: 'Volume Principal' }), { expand: true });
        this.volPercentLabel = new St.Label({ style_class: 'cc-vol-percent-label', text: '0%' });
        titleRow.add_actor(this.volPercentLabel);

        let sliderRow = new St.BoxLayout({ style_class: 'cc-slider-row', vertical: false });
        box.add_actor(sliderRow);

        this.muteBtn = new St.Button({ style_class: 'cc-mute-btn', reactive: true, track_hover: true });
        this.muteIcon = new St.Icon({ icon_name: 'audio-volume-high-symbolic', icon_type: St.IconType.SYMBOLIC, icon_size: 18 });
        this.muteBtn.set_child(this.muteIcon);
        this.muteBtn.connect('clicked', () => {
            Util.spawnCommandLine('pactl set-sink-mute @DEFAULT_SINK@ toggle');
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => { this._refreshVolume(); return false; });
        });
        sliderRow.add_actor(this.muteBtn);

        this.volumeSlider = new PopupMenu.PopupSliderMenuItem(0.5);
        this.volumeSlider.connect('value-changed', (item, value) => {
            // Clamp percentage to safe integer bounds [0, 150] before passing to pactl
            let num = Number(value);
            if (!Number.isFinite(num)) return;
            let pct = Math.max(0, Math.min(150, Math.round(num * 100)));
            this.volPercentLabel.set_text(pct + '%');
            Util.spawnCommandLine('pactl set-sink-volume @DEFAULT_SINK@ ' + pct + '%');
        });
        sliderRow.add(this.volumeSlider.actor, { expand: true });
    }

    /**
     * Builds the screen brightness slider. Uses Cinnamon's Power D-Bus backlight interface
     * when available (laptops) and falls back to `xrandr --brightness` (desktop monitors).
     */
    _buildBrightnessSlider() {
        let box = new St.BoxLayout({ style_class: 'cc-section-container', vertical: true });
        this.mainBox.add_actor(box);

        let titleRow = new St.BoxLayout({ vertical: false });
        box.add_actor(titleRow);
        titleRow.add(new St.Label({ style_class: 'cc-section-title', text: "Luminosité de l'Écran" }), { expand: true });
        this.brightPercentLabel = new St.Label({ style_class: 'cc-bright-percent-label', text: '100%' });
        titleRow.add_actor(this.brightPercentLabel);

        let sliderRow = new St.BoxLayout({ style_class: 'cc-slider-row', vertical: false });
        box.add_actor(sliderRow);

        this.brightIconBtn = new St.Button({ style_class: 'cc-mute-btn', reactive: true, track_hover: true });
        this.brightIcon = new St.Icon({ icon_name: 'display-brightness-symbolic', icon_type: St.IconType.SYMBOLIC, icon_size: 18 });
        this.brightIconBtn.set_child(this.brightIcon);
        this.brightIconBtn.connect('clicked', () => {
            this._setBrightness(1.0);
        });
        sliderRow.add_actor(this.brightIconBtn);

        this.brightnessSlider = new PopupMenu.PopupSliderMenuItem(1.0);
        this.brightnessSlider.connect('value-changed', (item, value) => {
            let val = Math.max(0.15, Math.min(1.0, Number(value) || 1.0));
            this._setBrightness(val);
        });
        sliderRow.add(this.brightnessSlider.actor, { expand: true });

        // Connect to Cinnamon Power DBus if available
        try {
            let Interfaces = imports.misc.interfaces;
            if (Interfaces && Interfaces.getDBusProxyAsync) {
                Interfaces.getDBusProxyAsync("org.cinnamon.SettingsDaemon.Power.Screen", (proxy, error) => {
                    if (!error && proxy) {
                        this._csdBacklightProxy = proxy;
                    }
                });
            }
        } catch (e) {}
    }

    /**
     * Detects and caches the primary connected X11 display output name via `xrandr --current`.
     * Validates the connector identifier against a strict alphanumeric/hyphen regex to prevent
     * unexpected argument injection when invoking `xrandr`.
     */
    _getPrimaryMonitorName() {
        if (this._cachedMonitorName) return this._cachedMonitorName;
        let out = runCmd('xrandr --current');
        let m = out.match(/^([A-Za-z0-9_.-]+)\s+connected\s+primary/m) ||
                out.match(/^([A-Za-z0-9_.-]+)\s+connected/m);
        this._cachedMonitorName = m ? m[1] : 'HDMI-A-0';
        return this._cachedMonitorName;
    }

    /**
     * Applies the requested screen brightness level (`val` in [0.15, 1.0]) via both
     * `xrandr` software gamma/brightness and the Cinnamon Power D-Bus backlight proxy.
     */
    _setBrightness(val) {
        let safeVal = Math.max(0.15, Math.min(1.0, Number(val) || 1.0));
        let pct = Math.round(safeVal * 100);
        this.brightPercentLabel.set_text(pct + '%');
        this.brightnessSlider.setValue(safeVal);
        this._currentBrightnessVal = safeVal;

        let mon = this._getPrimaryMonitorName();
        if (/^[A-Za-z0-9_.-]+$/.test(mon)) {
            Util.spawnCommandLine('xrandr --output ' + mon + ' --brightness ' + safeVal.toFixed(2));
        }

        if (this._csdBacklightProxy && this._csdBacklightProxy.SetPercentageRemote) {
            try {
                this._csdBacklightProxy.SetPercentageRemote(pct, () => {});
            } catch (e) {}
        }
    }

    /**
     * Queries the current screen brightness from the Cinnamon Power D-Bus backlight proxy
     * (or falls back to the last cached value) and updates the slider UI.
     */
    _refreshBrightness() {
        if (this._currentBrightnessVal !== undefined) {
            let pct = Math.round(this._currentBrightnessVal * 100);
            this.brightPercentLabel.set_text(pct + '%');
            this.brightnessSlider.setValue(this._currentBrightnessVal);
        } else {
            this._currentBrightnessVal = 1.0;
            this.brightPercentLabel.set_text('100%');
            this.brightnessSlider.setValue(1.0);
        }

        if (this._csdBacklightProxy && this._csdBacklightProxy.GetPercentageRemote) {
            try {
                this._csdBacklightProxy.GetPercentageRemote((pct, error) => {
                    if (!error && pct !== null && pct !== undefined) {
                        let v = pct / 100.0;
                        this._currentBrightnessVal = v;
                        this.brightPercentLabel.set_text(pct + '%');
                        this.brightnessSlider.setValue(v);
                    }
                });
            } catch (e) {}
        }
    }

    /**
     * Builds the bottom 3-tab view:
     *  0: Agenda / Calendar (month grid + event list + EDS calendar source picker)
     *  1: Notifications history
     *  2: System / systemd journal critical errors (priorities 0..3, deduplicated)
     */
    _buildTabs() {
        let tabsBox = new St.BoxLayout({ style_class: 'cc-tabs-container', vertical: true });
        this.mainBox.add_actor(tabsBox);

        let tabHeader = new St.BoxLayout({ style_class: 'cc-tab-header-box', vertical: false });
        tabsBox.add_actor(tabHeader);

        this.tabBtnCalendar = new St.Button({ style_class: 'cc-tab-btn active', label: '📅 Agenda', reactive: true, track_hover: true });
        this.tabBtnNotifs   = new St.Button({ style_class: 'cc-tab-btn',        label: '🔔 Notifs', reactive: true, track_hover: true });
        this.tabBtnErrors   = new St.Button({ style_class: 'cc-tab-btn',        label: '⚠️ Erreurs', reactive: true, track_hover: true });
        tabHeader.add(this.tabBtnCalendar, { expand: true });
        tabHeader.add(this.tabBtnNotifs,   { expand: true });
        tabHeader.add(this.tabBtnErrors,   { expand: true });

        this.tabBtnCalendar.connect('clicked', () => this._switchTab(0));
        this.tabBtnNotifs.connect('clicked',   () => this._switchTab(1));
        this.tabBtnErrors.connect('clicked',   () => this._switchTab(2));

        // ── 1. Calendar tab ──
        this.calContentBox = new St.BoxLayout({ style_class: 'cc-calendar-tab-box', vertical: true });
        tabsBox.add_actor(this.calContentBox);

        try {
            this.events_manager = new EventView.EventsManager(this.cal_settings, this.desktop_settings);
            this.calendarWidget = new Calendar.Calendar(this.cal_settings, this.events_manager);
            this.calendarWidget.connect('selected-date-changed', (cal, date) => {
                if (this.events_manager && this.events_manager.select_date) {
                    this.events_manager.select_date(date);
                }
            });
            this.event_list = this.events_manager.get_event_list();
            this.event_list.connect('launched-calendar', () => this.menu.close());

            let calSplit = new St.BoxLayout({ vertical: false, style_class: 'cc-cal-split' });
            this.calContentBox.add_actor(calSplit);
            calSplit.add_actor(this.calendarWidget.actor);
            calSplit.add(this.event_list.actor, { expand: true });

            // Calendar picker: header + one toggle row per EDS calendar.
            let calSrcHeader = new St.BoxLayout({ vertical: false, style_class: 'cc-cal-source-header' });
            calSrcHeader.add(new St.Label({ style_class: 'cc-cal-source-title', text: 'Calendriers' }),
                             { expand: true });
            let addAccountBtn = new St.Button({
                style_class: 'cc-cal-source-add',
                label: '+ Compte en ligne',
                reactive: true,
                track_hover: true
            });
            addAccountBtn.connect('clicked', () => {
                this.menu.close();
                this.on_online_accounts_pressed();
            });
            calSrcHeader.add_actor(addAccountBtn);
            this.calContentBox.add_actor(calSrcHeader);

            this.calSourcesBox = new St.BoxLayout({ vertical: true, style_class: 'cc-cal-sources-box' });
            this.calContentBox.add_actor(this.calSourcesBox);
            this._refreshCalendarSources();

            // Button to open full GNOME Calendar
            let openCalBtn = new St.Button({
                style_class: 'cc-open-calendar-btn',
                label: "Ouvrir l'application Calendrier",
                reactive: true,
                track_hover: true
            });
            openCalBtn.connect('clicked', () => {
                this.menu.close();
                Util.spawnCommandLine("gnome-calendar");
            });
            this.calContentBox.add_actor(openCalBtn);

        } catch (e) {
            global.logError('[ControlCenter] Calendar init error: ' + e);
            this.calContentBox.add_actor(new St.Label({ text: 'Calendrier non disponible', style_class: 'cc-notif-empty-label' }));
        }

        // ── 2. Notifications tab ──
        this.notifContentBox = new St.BoxLayout({ style_class: 'cc-notif-tab-box', vertical: true });
        this.notifContentBox.hide();
        tabsBox.add_actor(this.notifContentBox);

        let notifTopRow = new St.BoxLayout({ vertical: false, style_class: 'cc-notif-top-row' });
        this.notifContentBox.add_actor(notifTopRow);
        this.notifCountLabel = new St.Label({ style_class: 'cc-notif-count-label', text: 'Aucune notification' });
        notifTopRow.add(this.notifCountLabel, { expand: true });
        let clearBtn = new St.Button({ style_class: 'cc-clear-notifs-btn', label: 'Effacer', reactive: true });
        clearBtn.connect('clicked', () => { this.notifications = []; this._refreshNotifications(); });
        notifTopRow.add_actor(clearBtn);

        this.notifScrollView = new St.ScrollView({ style_class: 'cc-notif-scrollview vfade', x_fill: true, y_fill: true });
        this.notifContentBox.add(this.notifScrollView, { expand: true });
        this.notifItemsBox = new St.BoxLayout({ vertical: true, style_class: 'cc-notif-items-box' });
        this.notifScrollView.add_actor(this.notifItemsBox);

        // ── 3. System / Syslog Errors tab ──
        this.errorsContentBox = new St.BoxLayout({ style_class: 'cc-errors-tab-box', vertical: true });
        this.errorsContentBox.hide();
        tabsBox.add_actor(this.errorsContentBox);

        let errorsTopRow = new St.BoxLayout({ vertical: false, style_class: 'cc-notif-top-row' });
        this.errorsContentBox.add_actor(errorsTopRow);
        this.errorsCountLabel = new St.Label({ style_class: 'cc-notif-count-label', text: '15 dernières erreurs' });
        errorsTopRow.add(this.errorsCountLabel, { expand: true });

        let refreshErrorsBtn = new St.Button({ style_class: 'cc-clear-notifs-btn', label: '🔄 Actualiser', reactive: true });
        refreshErrorsBtn.connect('clicked', () => this._refreshErrors());
        errorsTopRow.add_actor(refreshErrorsBtn);

        this.errorsScrollView = new St.ScrollView({ style_class: 'cc-notif-scrollview vfade', x_fill: true, y_fill: true });
        this.errorsContentBox.add(this.errorsScrollView, { expand: true });
        this.errorsItemsBox = new St.BoxLayout({ vertical: true, style_class: 'cc-notif-items-box' });
        this.errorsScrollView.add_actor(this.errorsItemsBox);
    }

    /**
     * Switches the visible tab (0 = Calendar, 1 = Notifications, 2 = Journal Errors)
     * and refreshes the newly displayed view.
     */
    _switchTab(i) {
        this.tabBtnCalendar.style_class = i === 0 ? 'cc-tab-btn active' : 'cc-tab-btn';
        this.tabBtnNotifs.style_class   = i === 1 ? 'cc-tab-btn active' : 'cc-tab-btn';
        this.tabBtnErrors.style_class   = i === 2 ? 'cc-tab-btn active' : 'cc-tab-btn';

        this.calContentBox.hide();
        this.notifContentBox.hide();
        this.errorsContentBox.hide();

        if (i === 0) {
            this.calContentBox.show();
            this._refreshCalendar();
        } else if (i === 1) {
            this.notifContentBox.show();
            this._refreshNotifications();
        } else if (i === 2) {
            this.errorsContentBox.show();
            this._refreshErrors();
        }
    }

    // ── Refresh ────────────────────────────────────────────────────────────────
    /**
     * Refreshes all quick toggles, power profile buttons, audio volume, and screen brightness.
     */
    _refreshAllStates() {
        this.headerDateLabel.set_text(this._formatDate());
        this._refreshWifi();
        this._refreshBluetooth();
        this._refreshNightLight();
        this._refreshDnd();
        this._refreshPowerMode();
        this._refreshVolume();
        this._refreshBrightness();
    }

    /**
     * Reloads the calendar widget and requests the events for the currently selected date.
     */
    _refreshCalendar() {
        try {
            if (this.calendarWidget && this.calendarWidget.setDate) {
                this.calendarWidget.setDate(new Date(), true);
                if (this.events_manager && this.events_manager.select_date) {
                    let selDate = this.calendarWidget.getSelectedDate ? this.calendarWidget.getSelectedDate() : new Date();
                    this.events_manager.select_date(selDate, true);
                }
            }
        } catch (e) {
            global.logError('[ControlCenter] _refreshCalendar error: ' + e);
        }
    }

    /**
     * Queries `journalctl` for recent priority 0..3 (emerg, alert, crit, err) entries,
     * deduplicates identical messages across process PID restarts, and renders up to
     * 15 unique critical errors.
     */
    _refreshErrors() {
        this.errorsItemsBox.destroy_all_children();

        // Fetch enough lines from journalctl to find 15 unique distinct errors
        let raw = runCmd('journalctl -p 0..3 -n 500 --no-pager');
        if (!raw) {
            let emptyLabel = new St.Label({
                style_class: 'cc-notif-empty-label',
                text: '✨ Aucune erreur critique dans le journal'
            });
            this.errorsItemsBox.add_actor(emptyLabel);
            this.errorsCountLabel.set_text('0 erreur critique');
            return;
        }

        let lines = raw.split('\n').filter(l => l.trim().length > 0 && !l.startsWith('-- Boot') && !l.startsWith(' '));
        lines.reverse(); // Newest first

        let uniqueErrors = [];
        let seen = {};

        for (let line of lines) {
            let parsed = this._parseJournalLine(line);
            let timeStr = parsed.timeStr;
            let srvStr = parsed.srvStr;
            let msgStr = parsed.msgStr;

            // Normalize: strip [PID] suffix to deduplicate identical errors across process restarts
            let bracketIdx = srvStr.indexOf('[');
            let cleanSrv = (bracketIdx !== -1 ? srvStr.substring(0, bracketIdx) : srvStr).trim();
            let cleanMsg = msgStr.trim();
            let key = cleanSrv + ':::' + cleanMsg;

            if (!seen[key]) {
                seen[key] = true;
                uniqueErrors.push({ time: timeStr, service: srvStr, msg: msgStr });
                if (uniqueErrors.length >= 15) {
                    break;
                }
            }
        }

        this.errorsCountLabel.set_text(uniqueErrors.length + (uniqueErrors.length > 1 ? ' erreurs uniques' : ' erreur unique'));

        if (uniqueErrors.length === 0) {
            let emptyLabel = new St.Label({
                style_class: 'cc-notif-empty-label',
                text: '✨ Aucune erreur critique dans le journal'
            });
            this.errorsItemsBox.add_actor(emptyLabel);
            return;
        }

        uniqueErrors.forEach(err => {
            let card = new St.BoxLayout({ style_class: 'cc-error-card', vertical: true });
            
            let header = new St.BoxLayout({ vertical: false, style_class: 'cc-error-header' });
            card.add_actor(header);

            let srvLabel = new St.Label({ style_class: 'cc-error-service', text: err.service });
            header.add(srvLabel, { expand: true });

            let timeLabel = new St.Label({ style_class: 'cc-error-time', text: err.time });
            header.add(timeLabel, { expand: false });

            let msgLabel = new St.Label({ style_class: 'cc-error-msg', text: err.msg });
            if (msgLabel.clutter_text) {
                msgLabel.clutter_text.set_line_wrap(true);
            }
            card.add_actor(msgLabel);

            this.errorsItemsBox.add_actor(card);
        });
    }

    /**
     * Parses a standard `journalctl` syslog line in linear O(n) time without regular
     * expression backtracking (eliminates ReDoS risk on malformed log lines).
     *
     * @param {string} line - Raw syslog line from journalctl
     * @returns {{timeStr: string, srvStr: string, msgStr: string}}
     */
    _parseJournalLine(line) {
        let colonIdx = line.indexOf(': ');
        if (colonIdx <= 0) {
            return { timeStr: '', srvStr: 'Système', msgStr: line };
        }
        let header = line.substring(0, colonIdx).trim();
        let tokens = header.split(' ').filter(t => t.length > 0);
        if (tokens.length < 5) {
            return { timeStr: '', srvStr: 'Système', msgStr: line };
        }
        return {
            timeStr: tokens.slice(0, 3).join(' '),
            srvStr: tokens.slice(4).join(' '),
            msgStr: line.substring(colonIdx + 2)
        };
    }

    /**
     * Queries NetworkManager (`nmcli`) for the active Wi-Fi connection SSID and radio state.
     * Uses `lastIndexOf(':')` so SSIDs containing escaped colons (`\:`) are parsed accurately.
     */
    _refreshWifi() {
        // Check active connections first (most reliable)
        let active = runCmd('nmcli -t -f NAME,TYPE connection show --active');
        let ssid = '', isOn = false;
        if (active) {
            for (let line of active.split('\n')) {
                let lastColon = line.lastIndexOf(':');
                if (lastColon > 0) {
                    let rawName = line.substring(0, lastColon).replace(/\\:/g, ':');
                    let connType = line.substring(lastColon + 1);
                    if (connType.includes('wireless') || connType.includes('wifi')) {
                        ssid = rawName.replace(' automatique', '').trim();
                        isOn = true;
                        break;
                    }
                }
            }
        }
        // Fallback: radio state
        if (!isOn) {
            let radio = runCmd('nmcli radio wifi');
            isOn = radio.includes('enabled') || radio.includes('activ');
        }
        this.wifiToggle.setActive(isOn, isOn ? (ssid || 'Activé') : 'Désactivé');
    }

    /**
     * Toggles the Wi-Fi radio state via `nmcli radio wifi on|off`.
     */
    _toggleWifi() {
        let ns = !this.wifiToggle.active;
        this.wifiToggle.setActive(ns, ns ? 'Activation...' : 'Désactivé');
        Util.spawnCommandLine(ns ? 'nmcli radio wifi on' : 'nmcli radio wifi off');
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => { this._refreshWifi(); return false; });
    }

    /**
     * Checks Bluetooth adapter state via `rfkill` and `bluetoothctl`.
     */
    _refreshBluetooth() {
        let rfkill = runCmd('rfkill list bluetooth');
        let btctl  = runCmd('bluetoothctl show');
        let isOn = rfkill.includes('Soft blocked: no') ||
                   btctl.toLowerCase().includes('powered: yes');
        this.btToggle.setActive(isOn, isOn ? 'Activé' : 'Désactivé');
    }

    /**
     * Toggles Bluetooth soft-block and adapter power via `rfkill` and `bluetoothctl`.
     */
    _toggleBluetooth() {
        let ns = !this.btToggle.active;
        this.btToggle.setActive(ns, ns ? 'Activation...' : 'Désactivation...');
        if (ns) { Util.spawnCommandLine('rfkill unblock bluetooth'); Util.spawnCommandLine('bluetoothctl power on'); }
        else    { Util.spawnCommandLine('bluetoothctl power off');   Util.spawnCommandLine('rfkill block bluetooth'); }
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => { this._refreshBluetooth(); return false; });
    }

    /**
     * Reads the Cinnamon Night Light state from GSettings (`org.cinnamon.settings-daemon.plugins.color`).
     */
    _refreshNightLight() {
        try {
            let on = this.color_settings.get_boolean('night-light-enabled');
            this.nightToggle.setActive(on, on ? 'Activé' : 'Désactivé');
        } catch(e) { this.nightToggle.setActive(false, 'N/A'); }
    }

    /**
     * Flips the Cinnamon Night Light boolean in GSettings.
     */
    _toggleNightLight() {
        try {
            let on = this.color_settings.get_boolean('night-light-enabled');
            this.color_settings.set_boolean('night-light-enabled', !on);
            this.nightToggle.setActive(!on, !on ? 'Activé' : 'Désactivé');
        } catch(e) {}
    }

    /**
     * Reads the Do Not Disturb state (inverted `display-notifications` key in `org.cinnamon.desktop.notifications`).
     */
    _refreshDnd() {
        try {
            let notifs = this.notif_settings.get_boolean('display-notifications');
            this.dndToggle.setActive(!notifs, !notifs ? 'Activé' : 'Désactivé');
        } catch(e) { this.dndToggle.setActive(false, 'Désactivé'); }
    }

    /**
     * Toggles Do Not Disturb by flipping `display-notifications` in GSettings.
     */
    _toggleDnd() {
        try {
            let notifs = this.notif_settings.get_boolean('display-notifications');
            this.notif_settings.set_boolean('display-notifications', !notifs);
            this.dndToggle.setActive(notifs, notifs ? 'Activé' : 'Désactivé');
        } catch(e) {}
    }

    /**
     * Queries the active power profile via `powerprofilesctl get` and highlights the matching button.
     */
    _refreshPowerMode() {
        let current = runCmd('powerprofilesctl get') || 'balanced';
        for (let id in this.powerButtons) {
            this.powerButtons[id].style_class = (id === current) ? 'cc-power-mode-btn active' : 'cc-power-mode-btn';
        }
    }

    /**
     * Sets the system power profile via `powerprofilesctl set <id>` after validating
     * `id` against `ALLOWED_POWER_PROFILES`.
     */
    _setPowerMode(id) {
        if (!ALLOWED_POWER_PROFILES.includes(id)) return;
        Util.spawnCommandLine('powerprofilesctl set ' + id);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => { this._refreshPowerMode(); return false; });
    }

    /**
     * Queries PulseAudio/PipeWire default sink volume and mute status via `pactl`.
     * Extracts the percentage in linear time without backtracking regular expressions.
     */
    _refreshVolume() {
        let volRaw = runCmd('pactl get-sink-volume @DEFAULT_SINK@');
        let pctIdx = volRaw.indexOf('%');
        let val = 50;
        if (pctIdx > 0) {
            let prefix = volRaw.substring(Math.max(0, pctIdx - 4), pctIdx).trim();
            let parsed = Number.parseInt(prefix.split(' ').pop(), 10);
            if (!Number.isNaN(parsed)) {
                val = parsed;
            }
        }
        this.volPercentLabel.set_text(val + '%');
        this.volumeSlider.setValue(val / 100.0);

        let muteRaw = runCmd('pactl get-sink-mute @DEFAULT_SINK@').toLowerCase();
        let muted = muteRaw.includes('oui') || muteRaw.includes('yes');
        this.muteIcon.set_icon_name(muted ? 'audio-volume-muted-symbolic' : 'audio-volume-high-symbolic');
        this.muteBtn.style_class = muted ? 'cc-mute-btn muted' : 'cc-mute-btn';
    }

    /**
     * Callback invoked when Cinnamon's message tray emits `notify-applet-update`.
     */
    _onNotificationUpdate() { this._refreshNotifications(); }

    /**
     * Rebuilds the notification cards list in the Notifications tab.
     */
    _refreshNotifications() {
        this.notifItemsBox.destroy_all_children();
        let n = this.notifications.length;
        this.notifCountLabel.set_text(n === 0 ? 'Aucune notification' : n + ' notification(s)');
        if (n === 0) {
            this.notifItemsBox.add_actor(new St.Label({ style_class: 'cc-notif-empty-label', text: 'Tout est à jour ✨' }));
        } else {
            this.notifications.forEach(notif => {
                let card = new St.BoxLayout({ style_class: 'cc-notif-card', vertical: true });
                card.add_actor(new St.Label({ style_class: 'cc-notif-title', text: notif.title || 'Notification' }));
                card.add_actor(new St.Label({ style_class: 'cc-notif-body',  text: notif.bannerBodyText || '' }));
                this.notifItemsBox.add_actor(card);
            });
        }
    }
}

/**
 * Cinnamon applet entry point.
 */
function main(metadata, orientation, panel_height, instance_id) {
    return new CinnamonControlCenterApplet(metadata, orientation, panel_height, instance_id);
}
