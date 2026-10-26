# Telegram native header limits and compact layout

Reviewed the current official Mini Apps API on 2026-10-26:
https://core.telegram.org/bots/webapps#initializing-mini-apps

Telegram exposes `expand()` and (8.0+) `requestFullscreen()` / `exitFullscreen()`.
It does **not** expose a native close, overflow/menu, or minimize button size,
opacity, shape, position, or header-height setting. `BackButton` controls a
separate optional back button. `BottomButton` controls app action buttons, not
Telegram's native top controls. Do not misrepresent these as native resizing.

Official fullscreen makes the header transparent. Telegram recommends setting
`setHeaderColor` even in fullscreen because it determines contrasting status-bar
and control colors. Our app matches the header surface and, on 7.10+ clients,
the bottom bar (including Android navigation bar); old header APIs receive the
official `bg_color` keyword. Colors update on theme/fullscreen changes. We never
attempt to lower the contrast of native exit controls or cover them.

Mobile launch expands first as a fallback, then requests fullscreen on supported
iOS/Android clients only. An already-fullscreen session is not expanded or
requested again. Native events are registered before the request; denial returns
to ordinary expanded layout. Leaving fullscreen does not automatically force
re-entry. Telegram still owns whether a request is granted and all control sizes.

Only after `isFullscreen` is true, we compact **our own** header, hide redundant
branding metadata, reduce its extra top padding from 12 to 4 CSS pixels, and
compact full-height dialog headers. Search/account actions remain available.
Both system and Telegram content-safe insets remain reserved in full. We do not
subtract an assumed button height or absolute-position app content into controls.
Inset changes, rotation and fullscreen exit restore the appropriate layout.
No viewport trick, control overlay, SDK patch, exit interception or infinite
fullscreen retry is used.

Tests exercise iOS/Android API stubs, expanded/fullscreen/denial transitions,
color APIs, safe-area updates, scrolling and narrow/wide layouts in Chromium and
WebKit. Browser stubs cannot render Telegram's native controls. Physical
Telegram iPhone/Android verification is still required to judge their exact
appearance; native button dimensions must not be claimed as reduced.
