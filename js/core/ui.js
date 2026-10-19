/*
 * UI kit: icons, toasts, dialogs (confirm/prompt/alert replacements), context menus, popovers, tooltips.
 * Never use window.alert/confirm/prompt in this app — use App.ui.* so everything matches the design system.
 */
(() => {
    'use strict';
    const { h, escapeHtml } = App.util;

    // ---------- Icons (24x24 stroke icons; paths adapted from Lucide/Feather, ISC/MIT) ----------
    const ICONS = {
        aperture: '<circle cx="12" cy="12" r="10"/><path d="m14.31 8 5.74 9.94M9.69 8h11.48M7.38 12l5.74-9.94M9.69 16 3.95 6.06M14.31 16H2.83M16.62 12l-5.74 9.94"/>',
        folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>',
        'folder-open': '<path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"/>',
        'folder-plus': '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/><path d="M12 10v6M9 13h6"/>',
        'folder-input': '<path d="M2 9V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1"/><path d="M2 13h10M9 16l3-3-3-3"/>',
        'folder-output': '<path d="M2 9V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1"/><path d="M2 13h10M5 10l-3 3 3 3"/>',
        image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
        video: '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m22 8-6 4 6 4V8Z"/>',
        film: '<rect x="2" y="2" width="20" height="20" rx="2.18"/><path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5"/>',
        file: '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><path d="M14 2v6h6"/>',
        note: '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
        'chevron-left': '<path d="m15 18-6-6 6-6"/>',
        'chevron-right': '<path d="m9 18 6-6-6-6"/>',
        'chevron-down': '<path d="m6 9 6 6 6-6"/>',
        'chevron-up': '<path d="m18 15-6-6-6 6"/>',
        'arrow-left': '<path d="M19 12H5M12 19l-7-7 7-7"/>',
        'arrow-right': '<path d="M5 12h14M12 5l7 7-7 7"/>',
        'arrow-up': '<path d="M12 19V5M5 12l7-7 7 7"/>',
        'corner-up': '<path d="M14 9 9 4 4 9"/><path d="M20 20h-7a4 4 0 0 1-4-4V4"/>',
        search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
        x: '<path d="M18 6 6 18M6 6l12 12"/>',
        plus: '<path d="M12 5v14M5 12h14"/>',
        minus: '<path d="M5 12h14"/>',
        check: '<path d="M20 6 9 17l-5-5"/>',
        trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/>',
        edit: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
        copy: '<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
        star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
        tag: '<path d="M12.59 2.59A2 2 0 0 0 11.17 2H4a2 2 0 0 0-2 2v7.17a2 2 0 0 0 .59 1.41l8.7 8.7a2.43 2.43 0 0 0 3.42 0l6.58-6.58a2.43 2.43 0 0 0 0-3.42Z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
        hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
        settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
        sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
        more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
        'more-vertical': '<circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>',
        grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
        list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
        play: '<path d="M6 4l14 8-14 8V4z"/>',
        pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
        'skip-back': '<path d="m19 20-10-8 10-8v16zM5 19V5"/>',
        'skip-forward': '<path d="m5 4 10 8-10 8V4zM19 5v14"/>',
        volume: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/>',
        'volume-x': '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m23 9-6 6M17 9l6 6"/>',
        scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/>',
        camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
        'rotate-ccw': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
        'rotate-cw': '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
        'flip-h': '<path d="M8 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h3M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3M12 20v2M12 14v2M12 8v2M12 2v2"/>',
        'flip-v': '<path d="M21 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v3M21 16v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3M4 12H2M10 12H8M16 12h-2M22 12h-2"/>',
        refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
        filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/>',
        sort: '<path d="m21 16-4 4-4-4M17 20V4M3 8l4-4 4 4M7 4v16"/>',
        sidebar: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
        'panel-right': '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>',
        info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
        alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/>',
        'check-circle': '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
        'x-circle': '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>',
        upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
        download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
        home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
        undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
        redo: '<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7"/>',
        layers: '<path d="m12 2 10 5-10 5L2 7l10-5z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
        zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
        keyboard: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/>',
        command: '<path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"/>',
        server: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 6h.01M6 18h.01"/>',
        maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
        'zoom-in': '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/>',
        'zoom-out': '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M8 11h6"/>',
        external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
        clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
        calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
        bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>',
        flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
        sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
        moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
        sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>',
        eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
        'eye-off': '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61M2 2l20 20"/>',
        merge: '<path d="m8 6 4-4 4 4M12 2v10.3a4 4 0 0 1-1.17 2.83L4 22M20 22l-5-5"/>',
        'drag-handle': '<circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/>',
        activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
        box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>',
        'list-collapse': '<path d="m7 20 5-5 5 5"/><path d="m7 4 5 5 5-5"/>',
        monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
        'hard-drive': '<path d="M22 12H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><path d="M6 16h.01M10 16h.01"/>',
        database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
        'shield-check': '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
        'mouse-pointer': '<path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="m13 13 6 6"/>',
        'corner-down-left': '<path d="M20 4v7a4 4 0 0 1-4 4H4"/><path d="m9 10-5 5 5 5"/>',
        lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
        history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
        'cloud-off': '<path d="m2 2 20 20"/><path d="M5.78 5.78A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.31-.2"/><path d="M21.53 16.53A4.5 4.5 0 0 0 17.5 10h-1.79A7 7 0 0 0 9.5 5.02"/>',
        'panel-left-close': '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M16 15l-3-3 3-3"/>',
        repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
        minimize: '<path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"/>',
        'map-pin': '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
        shuffle: '<path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22"/><path d="m18 2 4 4-4 4"/><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2"/><path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"/><path d="m18 14 4 4-4 4"/>',
        save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
        gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
        palette: '<circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.56-2.5 5.56-5.55C21.97 6.01 17.46 2 12 2z"/>',
        mouse: '<rect x="5" y="2" width="14" height="20" rx="7"/><path d="M12 6v4"/>',
        'volume-1': '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>',
        fit: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="7" y="7" width="10" height="10" rx="1"/>',
    };
    const FILLED = new Set(['play', 'star']);

    function icon(name, opts = {}) {
        const body = ICONS[name] || ICONS.info;
        const size = opts.size || 16;
        const cls = ['ico', FILLED.has(name) && opts.filled !== false ? 'fill' : '', opts.class || ''].filter(Boolean).join(' ');
        const style = size !== 16 ? ` style="width:${size}px;height:${size}px"` : '';
        return `<svg class="${cls}" width="${size}" height="${size}"${style} viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
    }

    function iconEl(name, opts) {
        const tpl = document.createElement('template');
        tpl.innerHTML = icon(name, opts);
        return tpl.content.firstChild;
    }

    // ---------- Toasts ----------
    const toastMap = new Map();
    let toastRoot = null;

    function ensureToastRoot() {
        if (!toastRoot) {
            toastRoot = h('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' });
            document.body.append(toastRoot);
        }
        return toastRoot;
    }

    const TOAST_ICONS = { success: 'check-circle', error: 'x-circle', warning: 'alert', info: 'info' };

    /**
     * toast(message, { type: 'info'|'success'|'error'|'warning'|'loading', duration (ms, 0 = sticky),
     *                  action: { label, run }, id (reuse/update an existing toast) })
     */
    const MAX_TOASTS = 3;

    function toast(message, opts = {}) {
        const type = opts.type || 'info';
        const duration = opts.duration ?? (type === 'error' ? 6000 : type === 'loading' ? 0 : 3200);
        // Never stack: an explicit id, or the same message already on screen, updates that toast in place
        const key = opts.id || `${type}|${message}`;
        let handle = toastMap.get(key);

        if (!handle) {
            const el = h('div', { class: 'toast' });
            const root = ensureToastRoot();
            root.append(el);
            handle = {
                el,
                timer: null,
                close() {
                    clearTimeout(handle.timer);
                    if (toastMap.get(key) === handle) toastMap.delete(key);
                    el.classList.add('leaving');
                    setTimeout(() => el.remove(), 180);
                },
                update(msg, o = {}) {
                    render(msg, { ...opts, ...o });
                },
            };
            el._toast = handle;
            toastMap.set(key, handle);
            // Keep the pile short: drop the oldest when too many are visible
            const live = [...root.children].filter((c) => !c.classList.contains('leaving'));
            for (const old of live.slice(0, Math.max(0, live.length - MAX_TOASTS))) old._toast?.close();
        }

        function render(msg, o) {
            const t = o.type || 'info';
            const el = handle.el;
            el.innerHTML = '';
            el.append(t === 'loading' ? h('span', { class: 'spinner' }) : h('span', { class: `toast-icon ${t}`, html: icon(TOAST_ICONS[t] || 'info') }));
            el.append(h('span', { class: 'toast-msg', text: msg }));
            if (o.action) {
                el.append(h('button', {
                    class: 'toast-action',
                    text: o.action.label,
                    onclick: () => {
                        handle.close();
                        o.action.run();
                    },
                }));
            }
            el.append(h('button', { class: 'toast-close', 'aria-label': '닫기', html: icon('x', { size: 14 }), onclick: () => handle.close() }));
            clearTimeout(handle.timer);
            const d = o.duration ?? (t === 'error' ? 6000 : t === 'loading' ? 0 : 3200);
            if (d > 0) handle.timer = setTimeout(() => handle.close(), d);
        }

        render(message, { ...opts, type, duration });
        return handle;
    }

    // ---------- Dialogs ----------
    const dialogStack = []; // only the top-most dialog reacts to Esc/Enter
    /**
     * dialog({ title, body: string|Node, actions: [{label, value, kind: 'primary'|'danger'|'ghost', autofocus}],
     *          width, dismissValue, init(el, close) }) -> Promise<value>
     * Esc resolves with dismissValue (default null). Enter triggers the primary/danger action (not inside textarea).
     */
    function dialog(opts) {
        return new Promise((resolve) => {
            const backdrop = h('div', { class: 'dialog-backdrop' });
            const box = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' });
            if (opts.width) box.style.width = `min(${opts.width}px, 100%)`;

            if (opts.title) {
                box.append(h('div', { class: 'dialog-head' }, h('h3', { class: 'dialog-title', text: opts.title })));
            }
            const body = h('div', { class: 'dialog-body' });
            if (typeof opts.body === 'string') body.innerHTML = opts.body;
            else if (opts.body) body.append(opts.body);
            box.append(body);

            let closed = false;
            const previousFocus = document.activeElement;
            const self = { box };
            dialogStack.push(self);
            const close = (value) => {
                if (closed) return;
                closed = true;
                document.removeEventListener('keydown', onKey, true);
                const i = dialogStack.indexOf(self);
                if (i >= 0) dialogStack.splice(i, 1);
                backdrop.remove();
                App.layers.pop('dialog');
                if (previousFocus && previousFocus.focus) previousFocus.focus();
                resolve(value);
            };

            const actions = opts.actions || [{ label: '확인', value: true, kind: 'primary' }];
            const foot = h('div', { class: 'dialog-foot' });
            let primaryBtn = null;
            let autofocusBtn = null;
            for (const a of actions) {
                const btn = h('button', { class: `btn ${a.kind || ''}`, text: a.label, onclick: () => (a.onClick ? a.onClick(close) : close(a.value)) });
                if (a.kind === 'primary' || a.kind === 'danger') primaryBtn = btn;
                if (a.autofocus) autofocusBtn = btn;
                foot.append(btn);
            }
            if (actions.length) box.append(foot);

            function onKey(e) {
                // Nested dialogs: only the top one; open menus/popovers handle their own keys first
                if (dialogStack[dialogStack.length - 1] !== self || App.layers.top() === 'menu') return;
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    close(opts.dismissValue ?? null);
                } else if (e.key === 'Enter' && !e.isComposing && e.target.tagName !== 'TEXTAREA' && primaryBtn && !primaryBtn.disabled) {
                    e.preventDefault();
                    e.stopPropagation();
                    primaryBtn.click();
                }
            }
            document.addEventListener('keydown', onKey, true);

            backdrop.addEventListener('mousedown', (e) => {
                if (e.target === backdrop && opts.dismissible !== false) close(opts.dismissValue ?? null);
            });

            backdrop.append(box);
            document.body.append(backdrop);
            App.layers.push('dialog');

            if (opts.init) opts.init(box, close, { primaryBtn });
            if (!box.contains(document.activeElement)) (autofocusBtn || primaryBtn || foot.lastChild)?.focus();
        });
    }

    function confirm(opts) {
        if (typeof opts === 'string') opts = { message: opts };
        return dialog({
            title: opts.title || '확인',
            body: h('p', { text: opts.message || '' }),
            dismissValue: false,
            actions: [
                { label: opts.cancelLabel || '취소', value: false, kind: 'ghost' },
                { label: opts.okLabel || '확인', value: true, kind: opts.danger ? 'danger' : 'primary', autofocus: true },
            ],
        });
    }

    function alert(opts) {
        if (typeof opts === 'string') opts = { message: opts };
        return dialog({
            title: opts.title || '알림',
            body: h('p', { text: opts.message || '' }),
            actions: [{ label: opts.okLabel || '확인', value: true, kind: 'primary', autofocus: true }],
        });
    }

    /**
     * prompt({ title, message, label, value, placeholder, okLabel, validate(v) -> errorText|null, selectStem })
     * -> Promise<string|null>. selectStem selects the filename without extension (for renames).
     */
    function prompt(opts) {
        const input = h('input', { class: 'input', type: 'text', value: opts.value ?? '', placeholder: opts.placeholder || '', spellcheck: 'false' });
        const error = h('div', { class: 'field-error' });
        const body = h('div', null,
            opts.message ? h('p', { text: opts.message }) : null,
            h('div', { class: 'field' }, opts.label ? h('label', { text: opts.label }) : null, input, error));

        return dialog({
            title: opts.title || '입력',
            body,
            actions: [
                { label: '취소', value: null, kind: 'ghost' },
                {
                    label: opts.okLabel || '확인',
                    kind: 'primary',
                    onClick: (close) => {
                        const v = input.value.trim();
                        const err = opts.validate ? opts.validate(v) : (v ? null : '값을 입력하세요');
                        if (err) {
                            error.textContent = err;
                            input.classList.add('invalid');
                            input.focus();
                            return;
                        }
                        close(v);
                    },
                },
            ],
            init(box, close, { primaryBtn }) {
                const check = () => {
                    const v = input.value.trim();
                    const err = opts.validate ? opts.validate(v) : (v ? null : '');
                    error.textContent = err || '';
                    input.classList.toggle('invalid', !!err);
                    primaryBtn.disabled = !!err || !v;
                };
                input.addEventListener('input', check);
                input.focus();
                if (opts.selectStem && input.value.lastIndexOf('.') > 0) input.setSelectionRange(0, input.value.lastIndexOf('.'));
                else input.select();
                check();
            },
        });
    }

    // ---------- Menus ----------
    let openMenus = [];

    function closeMenus(fromLevel = 0) {
        const toClose = openMenus.splice(fromLevel);
        for (const m of toClose) m.el.remove();
        if (fromLevel === 0 && toClose.length) {
            App.layers.pop('menu');
            document.removeEventListener('mousedown', onDocMouseDown, true);
            document.removeEventListener('keydown', onMenuKey, true);
            window.removeEventListener('blur', onWinBlur);
            window.removeEventListener('resize', onWinBlur);
        }
    }

    function onDocMouseDown(e) {
        if (!openMenus.some((m) => m.el.contains(e.target))) closeMenus(0);
    }

    function onWinBlur() {
        closeMenus(0);
    }

    function onMenuKey(e) {
        const top = openMenus[openMenus.length - 1];
        if (!top) return;
        const items = [...top.el.querySelectorAll('.menu-item:not(.disabled)')];
        let idx = items.indexOf(top.el.querySelector('.menu-item.active'));
        const setActive = (i) => {
            items.forEach((it) => it.classList.remove('active'));
            if (items[i]) {
                items[i].classList.add('active');
                items[i].scrollIntoView({ block: 'nearest' });
            }
        };
        if (e.key === 'ArrowDown') {
            setActive((idx + 1) % items.length);
        } else if (e.key === 'ArrowUp') {
            setActive((idx - 1 + items.length) % items.length);
        } else if (e.key === 'Enter' || e.key === ' ') {
            if (items[idx]) items[idx].click();
        } else if (e.key === 'ArrowRight') {
            if (items[idx] && items[idx]._submenu) items[idx]._openSub(true);
        } else if (e.key === 'ArrowLeft' || e.key === 'Escape') {
            if (openMenus.length > 1 && e.key === 'ArrowLeft') closeMenus(openMenus.length - 1);
            else closeMenus(0);
        } else {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
    }

    function positionFloating(el, x, y, anchorRect) {
        const pad = 6;
        const r = el.getBoundingClientRect();
        let left = x;
        let top = y;
        if (left + r.width > window.innerWidth - pad) left = anchorRect ? anchorRect.left - r.width : window.innerWidth - r.width - pad;
        if (top + r.height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - r.height - pad);
        el.style.left = Math.max(pad, left) + 'px';
        el.style.top = Math.max(pad, top) + 'px';
    }

    function buildMenu(items, level) {
        const el = h('div', { class: 'menu', role: 'menu' });
        let subTimer = null;
        const hasChecks = items.some((it) => it && typeof it === 'object' && 'checked' in it);

        for (const it of items) {
            if (!it) continue;
            if (it === '-') {
                el.append(h('div', { class: 'menu-sep' }));
                continue;
            }
            if (it.header) {
                el.append(h('div', { class: 'menu-header', text: it.header }));
                continue;
            }
            const row = h('div', { class: `menu-item${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}`, role: 'menuitem' });
            if (hasChecks) row.append(h('span', { class: 'menu-check', html: it.checked ? icon('check', { size: 14 }) : '' }));
            if (it.icon) row.insertAdjacentHTML('beforeend', icon(it.icon, { size: 15 }));
            row.append(h('span', { class: 'menu-label', text: it.label }));
            if (it.hint || it.command) row.append(h('span', { class: 'menu-hint', text: it.hint || App.commands.displayKeys(it.command) }));
            if (it.submenu) {
                row.insertAdjacentHTML('beforeend', icon('chevron-right', { size: 14 }));
                row._submenu = it.submenu;
                row._openSub = (focusFirst) => {
                    closeMenus(level + 1);
                    const rect = row.getBoundingClientRect();
                    const sub = buildMenu(typeof it.submenu === 'function' ? it.submenu() : it.submenu, level + 1);
                    document.body.append(sub);
                    positionFloating(sub, rect.right - 2, rect.top - 5, rect);
                    openMenus.push({ el: sub });
                    if (focusFirst) sub.querySelector('.menu-item:not(.disabled)')?.classList.add('active');
                };
            }
            row.addEventListener('mouseenter', () => {
                el.querySelectorAll('.menu-item.active').forEach((n) => n.classList.remove('active'));
                row.classList.add('active');
                clearTimeout(subTimer);
                subTimer = setTimeout(() => {
                    if (row._submenu) row._openSub(false);
                    else closeMenus(level + 1);
                }, 110);
            });
            row.addEventListener('click', (e) => {
                e.stopPropagation();
                if (it.disabled) return;
                if (row._submenu) {
                    row._openSub(true);
                    return;
                }
                closeMenus(0);
                if (it.command) App.commands.run(it.command, it.args);
                else if (it.action) it.action();
            });
            el.append(row);
        }
        return el;
    }

    /**
     * menu(items, { x, y } | { anchor: Element, align: 'start'|'end' })
     * item: { label, icon, hint, command (id, shows its shortcut), action(), checked, danger, disabled, submenu: [...] } | '-' | { header }
     */
    function menu(items, pos = {}) {
        closeMenus(0);
        const el = buildMenu(items, 0);
        document.body.append(el);
        let x = pos.x;
        let y = pos.y;
        if (pos.anchor) {
            const r = pos.anchor.getBoundingClientRect();
            x = pos.align === 'end' ? r.right - el.offsetWidth : r.left;
            y = r.bottom + 4;
        }
        positionFloating(el, x ?? 0, y ?? 0);
        openMenus.push({ el });
        App.layers.push('menu');
        document.addEventListener('mousedown', onDocMouseDown, true);
        document.addEventListener('keydown', onMenuKey, true);
        window.addEventListener('blur', onWinBlur);
        window.addEventListener('resize', onWinBlur);
        return { close: () => closeMenus(0) };
    }

    // Attach a context menu builder to an element. builder(event) returns items (or null for none).
    function contextMenu(el, builder) {
        el.addEventListener('contextmenu', (e) => {
            const items = builder(e);
            if (!items || !items.length) return;
            e.preventDefault();
            e.stopPropagation();
            menu(items, { x: e.clientX, y: e.clientY });
        });
    }

    // ---------- Popover (anchored floating panel) ----------
    function popover(anchor, content, opts = {}) {
        const el = h('div', { class: `menu popover ${opts.class || ''}` });
        el.style.padding = opts.padding ?? '10px';
        el.append(content);
        document.body.append(el);
        const r = anchor.getBoundingClientRect();
        const x = opts.align === 'end' ? r.right - el.offsetWidth : r.left;
        positionFloating(el, x, opts.above ? r.top - el.offsetHeight - 6 : r.bottom + 6);
        const close = () => {
            el.remove();
            document.removeEventListener('mousedown', onDown, true);
            document.removeEventListener('keydown', onKey, true);
            opts.onClose?.();
        };
        const onDown = (e) => {
            if (!el.contains(e.target) && !anchor.contains(e.target)) close();
        };
        const onKey = (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                close();
            }
        };
        document.addEventListener('mousedown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        return { el, close };
    }

    // ---------- Tooltips: any element with data-tip="text" (optional data-tip-keys="Mod+K") ----------
    let tipEl = null;
    let tipTimer = null;
    let tipTarget = null;

    function hideTip() {
        clearTimeout(tipTimer);
        tipTarget = null;
        if (tipEl) {
            tipEl.remove();
            tipEl = null;
        }
    }

    document.addEventListener('mouseover', (e) => {
        const target = e.target.closest?.('[data-tip]');
        if (target === tipTarget) return;
        hideTip();
        if (!target) return;
        tipTarget = target;
        tipTimer = setTimeout(() => {
            if (!document.body.contains(target)) return;
            const keys = target.dataset.tipKeys;
            tipEl = h('div', { class: 'tooltip', html: escapeHtml(target.dataset.tip) + (keys ? `<span class="kbd">${escapeHtml(App.commands.displayCombo(keys))}</span>` : '') });
            document.body.append(tipEl);
            const r = target.getBoundingClientRect();
            const tr = tipEl.getBoundingClientRect();
            let top = r.bottom + 6;
            if (top + tr.height > window.innerHeight - 4) top = r.top - tr.height - 6;
            const left = App.util.clamp(r.left + r.width / 2 - tr.width / 2, 4, window.innerWidth - tr.width - 4);
            tipEl.style.left = left + 'px';
            tipEl.style.top = top + 'px';
        }, 450);
    });
    document.addEventListener('mousedown', hideTip, true);
    document.addEventListener('wheel', hideTip, { passive: true, capture: true });

    App.ui = { icon, iconEl, toast, dialog, confirm, alert, prompt, menu, closeMenus: () => closeMenus(0), contextMenu, popover, positionFloating, ICONS };
})();
