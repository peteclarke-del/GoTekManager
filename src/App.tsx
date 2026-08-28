import { useEffect, useState } from 'react'
import {
  CircleHelp,
  HardDrive,
  LayoutDashboard,
  Moon,
  Settings2,
  Sun,
  Usb,
} from 'lucide-react'
import { Empty, NoticeBar } from './components/Feedback'
import { MountPicker } from './components/MountPicker'
import { SettingsDialog } from './components/SettingsDialog'
import { useCaptureHarness } from './dev/captureHarness'
import type { MountedTarget, Notice, Page } from './domain/types'
import { useAsyncAction } from './hooks/useAsyncAction'
import { discoverMounts } from './native/commands'
import { FlowPage } from './pages/flow/FlowPage'
import { HelpPage } from './pages/HelpPage'
import { DevicesPage } from './pages/DevicesPage'
import { ProfilesPage } from './pages/ProfilesPage'
import {
  useProviders,
  useSettings,
  useTablePreferences,
  useWorkspace,
} from './state/useWorkspace'

const NAVIGATION: Array<[Page, typeof HardDrive]> = [
  ['Flow', LayoutDashboard],
  ['Profiles', HardDrive],
  ['Devices', Usb],
  ['Help', CircleHelp],
]

const PAGE_TITLES: Record<Page, string> = {
  Flow: 'Prepare GoTek media',
  Profiles: 'Profiles',
  Devices: 'Devices',
  Help: 'Help',
}

export function App() {
  const [page, setPage] = useState<Page>('Flow')
  const [settings, setSettings] = useSettings()
  const { providers, setCustom: setCustomProviders, configPath: providersPath, problems: providerProblems } =
    useProviders()
  const [preferences, setPreferences] = useTablePreferences()
  const {
    workspace,
    dispatch,
    activeProfile,
    collection,
    removalPolicy,
    loading,
    error: storeError,
  } = useWorkspace()

  const [notice, setNotice] = useState<Notice | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [mounts, setMounts] = useState<MountedTarget[]>([])
  const [selectedMounts, setSelectedMounts] = useState<string[]>([])
  const [showSystemMounts, setShowSystemMounts] = useState(false)
  const discovery = useAsyncAction()

  // Inert unless VITE_CAPTURE is set during development; see the harness.
  useCaptureHarness({
    dispatch,
    setPage,
    setSettings,
    existingProfileIds: workspace.profiles.map((profile) => profile.id),
  })

  // The theme class drives the palette; "system" defers to the OS preference.
  const themeClass =
    settings.theme === 'dark' ? 'dark' : settings.theme === 'system' ? 'system-theme' : ''

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
  }, [settings.theme])

  const refreshMounts = (includeSystem: boolean) =>
    discovery.run(async () => {
      const found = await discoverMounts(includeSystem)
      setMounts(found)
      setSelectedMounts((current) =>
        current.filter((path) => found.some((mount) => mount.path === path)),
      )
      return found
    })

  const openMountPicker = async () => {
    setPickerOpen(true)
    await refreshMounts(showSystemMounts)
  }

  const applyMountSelection = () => {
    const chosen = mounts.filter((mount) => selectedMounts.includes(mount.path))
    dispatch({ type: 'mountsSelected', mounts: chosen, defaults: settings.defaults })
    setPickerOpen(false)
    setSelectedMounts([])
    setNotice({
      kind: 'success',
      text: `Added ${chosen.length} profile${chosen.length === 1 ? '' : 's'} from discovered storage.`,
    })
  }

  return (
    <main className={`app ${themeClass}`.trim()}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <HardDrive />
          </span>
          <span>
            GoTek <b>Manager</b>
          </span>
        </div>
        <nav>
          {NAVIGATION.map(([name, Icon]) => (
            <button
              key={name}
              className={page === name ? 'active' : ''}
              aria-current={page === name ? 'page' : undefined}
              onClick={() => setPage(name)}
            >
              <Icon />
              <span>{name}</span>
            </button>
          ))}
        </nav>
        <div className="side-bottom">
          <button onClick={() => setSettingsOpen(true)}>
            <Settings2 />
            <span>Settings</span>
          </button>
          <button
            onClick={() =>
              setSettings((current) => ({
                ...current,
                theme: current.theme === 'dark' ? 'light' : 'dark',
              }))
            }
          >
            {settings.theme === 'dark' ? <Sun /> : <Moon />}
            <span>Theme</span>
          </button>
        </div>
      </aside>

      <section className="content">
        <header>
          <div>
            <p className="eyebrow">{page}</p>
            <h1>{PAGE_TITLES[page]}</h1>
          </div>
        </header>

        {notice && <NoticeBar notice={notice} dismiss={() => setNotice(null)} />}
        {providerProblems.length > 0 && (
          <div className="notice error">
            Online sources: {providerProblems.join('; ')}.
          </div>
        )}
        {storeError && (
          <div className="notice error">
            The library could not be saved: {storeError}
          </div>
        )}

        {loading && <Empty title="Opening your library…" />}

        {!loading && page === 'Flow' && (
          <FlowPage
            workspace={workspace}
            dispatch={dispatch}
            collection={collection}
            removalPolicy={removalPolicy}
            providers={providers}
            setCustomProviders={setCustomProviders}
            preferences={preferences}
            setPreferences={setPreferences}
            convertIncompatible={settings.convertIncompatible}
            notify={setNotice}
            manageProfiles={() => setPage('Profiles')}
          />
        )}

        {!loading && page === 'Profiles' && (
          <ProfilesPage
            profiles={workspace.profiles}
            active={activeProfile}
            collection={collection}
            defaults={settings.defaults}
            dispatch={dispatch}
            discoverMounts={() => void openMountPicker()}
            notify={setNotice}
          />
        )}

        {!loading && page === 'Devices' && (
          <DevicesPage profile={activeProfile} collection={collection} notify={setNotice} />
        )}

        {!loading && page === 'Help' && <HelpPage theme={settings.theme} />}
      </section>

      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          setSettings={setSettings}
          providersPath={providersPath}
          close={() => setSettingsOpen(false)}
          clearLibrary={() => {
            dispatch({ type: 'libraryCleared' })
            setNotice({
              kind: 'success',
              text: 'The local index was cleared. No files on disk were changed.',
            })
          }}
        />
      )}

      {pickerOpen && (
        <MountPicker
          mounts={mounts}
          selected={selectedMounts}
          setSelected={setSelectedMounts}
          showSystem={showSystemMounts}
          setShowSystem={setShowSystemMounts}
          refresh={(includeSystem) => void refreshMounts(includeSystem)}
          close={() => setPickerOpen(false)}
          apply={applyMountSelection}
          busy={discovery.busy}
          error={discovery.error}
        />
      )}
    </main>
  )
}
