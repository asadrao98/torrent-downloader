/**
 * Application entry point.
 *
 * Wiring order matters: the logger comes up first so startup failures are
 * recorded, then settings (which the engine needs to configure itself), then the
 * manager, then the window. The renderer is never created before IPC handlers
 * exist, so it cannot call into a half-built main process.
 */

import { app, BrowserWindow, dialog, nativeTheme, session, shell } from 'electron'
import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { APP_ID, APP_NAME, IPC } from '@shared/constants.js'
import type { MetadataPreview } from '@shared/types.js'
import { parseMagnet } from '@shared/magnet.js'
import { initLogger, getLogger, log, toLogDetail } from './logger.js'
import { SettingsStore } from './settings.js'
import { TorrentManager, clearStagingDir, stagingDirFor } from './torrent-manager.js'
import type { ManagerEvent } from './torrent-manager.js'
import { defaultDownloadPath, registerIpcHandlers } from './ipc.js'
import { Notifier } from './notifications.js'
import { AppTray } from './tray.js'
import { applyAppMenu } from './menu.js'

const __dirname = join(fileURLToPath(import.meta.url), '..')

const logger = () => log('main')

let mainWindow: BrowserWindow | null = null
let manager: TorrentManager | null = null
let settings: SettingsStore | null = null
let tray: AppTray | null = null
let notifier: Notifier | null = null
let quitting = false

/** Magnets that arrived before the window was ready. */
const pendingMagnets: string[] = []

// ---------------------------------------------------------------- single instance

// A second launch (including one triggered by clicking a magnet link) must hand
// its argument to the running app rather than starting a second engine, which
// would fight over the listen port and the session file.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const magnet = argv.find((arg) => arg.startsWith('magnet:'))
    if (magnet) handleExternalMagnet(magnet)
    showMainWindow()
  })
}

app.setName(APP_NAME)
if (process.platform === 'darwin') app.setAppUserModelId(APP_ID)

// ------------------------------------------------------------------ magnet: scheme

// Registering here covers the packaged app. In development the scheme points at
// the Electron binary rather than this app, so this only takes effect once the
// app is built and launched at least once.
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('magnet', process.execPath, [process.argv[1]!])
  }
} else {
  app.setAsDefaultProtocolClient('magnet')
}

app.on('open-url', (event, url) => {
  event.preventDefault()
  handleExternalMagnet(url)
})

function handleExternalMagnet(uri: string): void {
  const parsed = parseMagnet(uri)
  if (!parsed.ok) {
    logger().warn(`ignored an invalid external magnet: ${parsed.code}`)
    return
  }

  if (!mainWindow || mainWindow.webContents.isLoading()) {
    pendingMagnets.push(uri)
    return
  }

  // A magnet arriving from outside the app is never auto-started unless the
  // user has explicitly opted in: clicking a link on a web page should not
  // silently begin a download.
  const requiresConfirmation = settings?.get().general.confirmExternalMagnets ?? true
  mainWindow.webContents.send(IPC.EventMagnetExternal, { uri, requiresConfirmation })
  showMainWindow()
}

function flushPendingMagnets(): void {
  if (!mainWindow) return
  while (pendingMagnets.length > 0) {
    const uri = pendingMagnets.shift()!
    handleExternalMagnet(uri)
  }
}

// --------------------------------------------------------------------- window

function showMainWindow(): void {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return
  }
  void createWindow()
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 860,
    minHeight: 560,
    show: false,
    title: APP_NAME,
    // macOS look: inset traffic lights over a translucent sidebar.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    // Set explicitly so there is no white flash before the first paint.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f5f5f7',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      // The hardened trio. The renderer gets no Node, no shared context with
      // the preload, and runs inside the OS sandbox.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // No reason for the renderer to spawn more windows or run plugins.
      webviewTag: false,
      plugins: false,
      spellcheck: false
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    flushPendingMagnets()
  })

  // Anything that tries to navigate the window away from our own UI, or open a
  // new window, is handed to the system browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isDevServer = process.env.ELECTRON_RENDERER_URL
      ? url.startsWith(process.env.ELECTRON_RENDERER_URL)
      : false
    if (!url.startsWith('file://') && !isDevServer) {
      event.preventDefault()
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    }
  })

  mainWindow.on('close', (event) => {
    // Closing the window keeps the session running in the menu bar, which is the
    // behaviour a download client wants. Quit really quits.
    if (!quitting && tray?.visible) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (devServerUrl) {
    await mainWindow.loadURL(devServerUrl)
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * Content Security Policy for the renderer.
 *
 * The UI loads no remote code, fonts or images, so everything except our own
 * bundle is denied. `unsafe-inline` for styles is required because the renderer
 * sets CSS custom properties inline for progress bars.
 *
 * Scripts get no inline exemption in a packaged build. In development they must:
 * Vite's React plugin injects the React Refresh preamble as an inline
 * `<script type="module">`, and blocking it leaves the renderer unable to mount
 * at all -- a blank window. The relaxation is scoped to the dev server, which
 * only ever runs on localhost, and never reaches a shipped app.
 */
function applyContentSecurityPolicy(): void {
  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  const scriptSrc = devServerUrl ? `'self' 'unsafe-inline' ${devServerUrl}` : "'self'"
  const connectSrc = devServerUrl
    ? `'self' ${devServerUrl} ws://localhost:* ws://127.0.0.1:*`
    : "'self'"

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'none'",
            `script-src ${scriptSrc}`,
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data:",
            "font-src 'self'",
            `connect-src ${connectSrc}`,
            "form-action 'none'",
            "base-uri 'none'",
            "object-src 'none'",
            "frame-src 'none'"
          ].join('; ')
        ]
      }
    })
  })

  // Deny every permission request outright: the UI needs none of them.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false)
  })
}

// ----------------------------------------------------------------- app startup

async function bootstrap(): Promise<void> {
  const userDataDir = app.getPath('userData')
  const logDir = join(userDataDir, 'logs')
  initLogger(logDir)

  logger().info(
    `starting ${APP_NAME} ${app.getVersion()} ` +
      `(electron ${process.versions.electron}, node ${process.versions.node}, ${process.arch})`
  )

  const downloadPath = defaultDownloadPath()
  settings = await SettingsStore.open(userDataDir, downloadPath)
  getLogger().setVerbose(settings.get().advanced.verboseLogging)

  // Apply the saved theme before the window exists, so the first paint is right.
  nativeTheme.themeSource = settings.get().appearance.theme

  applyContentSecurityPolicy()

  const stagingDir = stagingDirFor(userDataDir)
  await clearStagingDir(stagingDir)

  notifier = new Notifier(() => settings?.get().general.showNotifications ?? false)

  manager = new TorrentManager({
    dataDir: userDataDir,
    stagingDir,
    getSettings: () => settings!.get()
  })

  manager.on((event: ManagerEvent) => {
    switch (event.type) {
      case 'snapshot':
        mainWindow?.webContents.send(IPC.EventTorrentsUpdate, {
          torrents: event.torrents,
          stats: event.stats
        })
        tray?.update(event.stats, settings?.get().bandwidth.downloadLimit)
        break
      case 'notify':
        notifier?.show(event.title, event.body)
        break
      case 'error':
        mainWindow?.webContents.send(IPC.EventDialogError, {
          title: event.title,
          message: event.message
        })
        break
    }
  })

  manager.onPreview((preview: MetadataPreview) => {
    mainWindow?.webContents.send(IPC.EventPreviewUpdate, preview)
  })

  getLogger().onEntry((entry) => {
    // Only stream warnings and errors to the renderer; debug traffic would be a
    // constant IPC drip for no benefit.
    if (entry.level === 'warn' || entry.level === 'error') {
      mainWindow?.webContents.send(IPC.EventLogEntry, entry)
    }
  })

  settings.onChange((next) => {
    getLogger().setVerbose(next.advanced.verboseLogging)
    nativeTheme.themeSource = next.appearance.theme
    void manager?.applySettings(next)
    applyLoginItem(next.general.launchAtLogin)
    syncTray(next.general.showInMenuBar)
    mainWindow?.webContents.send(IPC.EventSettingsChanged, next)
  })

  registerIpcHandlers({
    manager,
    settings,
    getMainWindow: () => mainWindow,
    showMainWindow,
    defaultDownloadPath: downloadPath
  })

  // Make sure the default download folder exists so the first add just works.
  await fs.mkdir(settings.get().downloads.defaultPath, { recursive: true }).catch((err) => {
    logger().warn(`could not create the default download folder: ${toLogDetail(err)}`)
  })

  tray = new AppTray({
    openApp: () => showMainWindow(),
    pauseAll: () => void manager?.pauseAll(),
    resumeAll: () => void manager?.resumeAll(),
    setDownloadLimit: (bytesPerSecond) => {
      void settings?.update({ bandwidth: { downloadLimit: bytesPerSecond } })
    },
    quit: () => {
      quitting = true
      app.quit()
    }
  })
  syncTray(settings.get().general.showInMenuBar)

  applyAppMenu({
    navigate: (route) => {
      showMainWindow()
      mainWindow?.webContents.send(IPC.EventNavigate, { route })
    },
    pasteMagnet: () => {
      showMainWindow()
      mainWindow?.webContents.send(IPC.EventNavigate, { route: '/add?paste=1' })
    },
    pauseAll: () => void manager?.pauseAll(),
    resumeAll: () => void manager?.resumeAll(),
    openLogs: () => void shell.openPath(getLogger().directory),
    getWindow: () => mainWindow
  })

  applyLoginItem(settings.get().general.launchAtLogin)

  await createWindow()

  // The engine comes up after the window so "Restoring torrents…" is visible.
  try {
    await manager.init()
  } catch (err) {
    logger().error(`engine failed to start: ${toLogDetail(err)}`)
    dialog.showErrorBox(
      'Torrent engine failed to start',
      'The BitTorrent engine could not be started. Check the logs via Settings → Advanced → Open Logs Folder.'
    )
  }

  manager.refresh()
  flushPendingMagnets()
}

function syncTray(enabled: boolean): void {
  if (!tray) return
  if (enabled) tray.show()
  else tray.hide()
}

function applyLoginItem(enabled: boolean): void {
  // Only meaningful for a packaged, signed app; in development the login item
  // would point at the Electron binary.
  if (process.defaultApp) return
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true })
  } catch (err) {
    log('main').warn(`could not update the login item: ${toLogDetail(err)}`)
  }
}

// ------------------------------------------------------------------- lifecycle

app.whenReady().then(
  () => {
    void bootstrap().catch((err) => {
      log('main').error(`bootstrap failed: ${toLogDetail(err)}`)
      dialog.showErrorBox(
        'Torrent Downloader could not start',
        'Something went wrong during startup. The log file has the details.'
      )
    })
  },
  (err) => {
    console.error('app failed to become ready', err)
  }
)

app.on('activate', () => {
  showMainWindow()
})

app.on('window-all-closed', () => {
  // With a menu bar item present the session keeps running; without it, closing
  // the last window should quit, as on any other Mac app.
  if (!tray?.visible) app.quit()
})

app.on('before-quit', async (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()

  logger().info('shutting down')
  try {
    // Persist bitfields and stop the engine cleanly so the next launch resumes
    // rather than rehashing everything.
    await manager?.shutdown()
    await settings?.flush()
  } catch (err) {
    logger().error(`shutdown error: ${toLogDetail(err)}`)
  } finally {
    getLogger().close()
    app.exit(0)
  }
})

process.on('uncaughtException', (err) => {
  try {
    log('main').error(`uncaught exception: ${toLogDetail(err)}`)
  } catch {
    console.error('uncaught exception', err)
  }
})

process.on('unhandledRejection', (reason) => {
  try {
    log('main').error(`unhandled rejection: ${toLogDetail(reason)}`)
  } catch {
    console.error('unhandled rejection', reason)
  }
})
