import { Component, ReactNode } from 'react'
import { withTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

interface Props {
  children: ReactNode
  fallback?: ReactNode
  t: TFunction
}

interface State {
  hasError: boolean
  error: Error | null
}

class ErrorBoundaryInner extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error('[ErrorBoundary] Caught error:', error, info.componentStack)
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    const { t } = this.props
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback

      return (
        <div className="min-h-screen bg-canvas flex items-center justify-center p-8">
          <div className="bg-surface border border-danger/25 rounded-2xl p-8 max-w-lg w-full space-y-4 text-center">
            <div className="text-4xl">⚠️</div>
            <h2 className="page-title">{t('errorBoundary.title')}</h2>
            <p className="text-sm text-secondary">
              {t('errorBoundary.body')}
            </p>
            {this.state.error && (
              <pre className="text-left bg-subtle rounded-lg p-3 text-xs text-danger overflow-auto max-h-40">
                {this.state.error.message}
              </pre>
            )}
            <div className="flex gap-3 justify-center pt-2">
              <button
                onClick={this.handleReset}
                className="px-4 py-2 bg-accent hover:bg-accent-hover text-on-accent text-sm rounded-lg transition-colors"
              >
                {t('errorBoundary.retry')}
              </button>
              <button
                onClick={() => window.location.assign('/dashboard')}
                className="px-4 py-2 bg-emphasis hover:bg-emphasis text-primary text-sm rounded-lg transition-colors"
              >
                {t('errorBoundary.dashboard')}
              </button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

export default withTranslation()(ErrorBoundaryInner)
