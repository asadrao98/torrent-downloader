/**
 * The application menu.
 *
 * Keeps the standard macOS arrangement so the app behaves the way a Mac user
 * expects, and adds the few torrent-specific commands worth a keyboard shortcut.
 */

import { Menu, app, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { APP_NAME } from '@shared/constants.js'

export interface MenuActions {
  navigate(route: string): void
  pasteMagnet(): void
  pauseAll(): void
  resumeAll(): void
  openLogs(): void
  getWindow(): BrowserWindow | null
}

export function buildAppMenu(actions: MenuActions): Menu {
  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: APP_NAME,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              {
                label: 'Settings…',
                accelerator: 'Cmd+,',
                click: () => actions.navigate('/settings')
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Add Torrent…',
          accelerator: 'CmdOrCtrl+N',
          click: () => actions.navigate('/add')
        },
        {
          label: 'Paste Magnet Link',
          accelerator: 'CmdOrCtrl+V',
          click: () => actions.pasteMagnet()
        },
        { type: 'separator' },
        {
          label: 'Pause All',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => actions.pauseAll()
        },
        {
          label: 'Resume All',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => actions.resumeAll()
        },
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        // The renderer handles paste itself in text fields; this keeps the
        // standard shortcut working everywhere else.
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'All Torrents', accelerator: 'CmdOrCtrl+1', click: () => actions.navigate('/torrents/all') },
        { label: 'Downloading', accelerator: 'CmdOrCtrl+2', click: () => actions.navigate('/torrents/downloading') },
        { label: 'Seeding', accelerator: 'CmdOrCtrl+3', click: () => actions.navigate('/torrents/seeding') },
        { label: 'Completed', accelerator: 'CmdOrCtrl+4', click: () => actions.navigate('/torrents/completed') },
        { label: 'Paused', accelerator: 'CmdOrCtrl+5', click: () => actions.navigate('/torrents/paused') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: isMac
        ? [
            { role: 'minimize' },
            { role: 'zoom' },
            { type: 'separator' },
            { role: 'front' },
            { type: 'separator' },
            { role: 'window' }
          ]
        : [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }]
    },
    {
      role: 'help',
      submenu: [
        { label: 'Open Logs Folder', click: () => actions.openLogs() },
        {
          label: 'BitTorrent Protocol (BEP 3)',
          click: () => {
            void shell.openExternal('https://www.bittorrent.org/beps/bep_0003.html')
          }
        }
      ]
    }
  ]

  return Menu.buildFromTemplate(template)
}

export function applyAppMenu(actions: MenuActions): void {
  Menu.setApplicationMenu(buildAppMenu(actions))
  // Keep the dock menu useful too.
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setMenu(
      Menu.buildFromTemplate([
        { label: 'Pause All', click: () => actions.pauseAll() },
        { label: 'Resume All', click: () => actions.resumeAll() }
      ])
    )
  }
}
