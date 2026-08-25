/**
 * macOS notifications.
 *
 * Deliberately thin: notifications are a courtesy, so a platform that cannot
 * show them (or a user who turned them off) must never produce an error.
 */

import { Notification } from 'electron'
import { log, toLogDetail } from './logger.js'

export class Notifier {
  private available: boolean

  constructor(private readonly isEnabled: () => boolean) {
    this.available = Notification.isSupported()
    if (!this.available) {
      log('notify').info('system notifications are not available on this platform')
    }
  }

  show(title: string, body: string): void {
    if (!this.available || !this.isEnabled()) return
    try {
      const notification = new Notification({
        title,
        body,
        silent: false
      })
      notification.show()
    } catch (err) {
      log('notify').warn(`could not show notification: ${toLogDetail(err)}`)
    }
  }
}
