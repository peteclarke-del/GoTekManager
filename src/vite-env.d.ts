/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set by scripts/capture-screenshots.sh; absent in every normal run. */
  readonly VITE_CAPTURE?: string
  readonly VITE_CAPTURE_LIBRARY?: string
  readonly VITE_CAPTURE_DESTINATION?: string
  readonly VITE_CAPTURE_DESTINATION_2?: string
  readonly VITE_CAPTURE_HELP?: string
  readonly VITE_CAPTURE_DIALOGS?: string
  readonly VITE_CAPTURE_ENDPOINT?: string
  readonly VITE_CAPTURE_THEME?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** The version in package.json, compiled in by vite. See vite.config.ts. */
declare const __APP_VERSION__: string
