import '@testing-library/jest-dom/vitest'
import i18n, { WORKSPACE_NAMESPACE } from '../i18n'
import { workspace as en } from '../i18n/locales/en'
import { workspace as zh } from '../i18n/locales/zh'

// Component tests mount pages directly, outside the workspace that loads translations.
i18n.addResourceBundle('en', WORKSPACE_NAMESPACE, en)
i18n.addResourceBundle('zh', WORKSPACE_NAMESPACE, zh)

// jsdom lacks the dialog methods. Browser tests cover top-layer focus and Escape.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () {
    if (!this.open) return
    this.open = false
    queueMicrotask(() => this.dispatchEvent(new Event('close')))
  }
}
