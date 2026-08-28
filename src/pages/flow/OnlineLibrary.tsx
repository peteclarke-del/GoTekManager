import { Fragment, useEffect, useMemo, useState } from 'react'
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Download,
  Globe2,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react'
import { Empty, InlineStatus, ProgressDialog } from '../../components/Feedback'
import { Modal } from '../../components/Modal'
import { platforms, requirePlatform, type Platform } from '../../domain/catalog'
import { belongsToPlatform, formatBytes, softwareTitleKey } from '../../domain/media'
import {
  adapterLabel,
  faultIn,
  isBrowsable,
  isDownloadable,
  providersFor,
  scopeLabel,
} from '../../domain/providers'
import type {
  CachedDownload,
  MediaItem,
  OnlineProvider,
  OnlineTitle,
  ProviderAdapter,
  ProviderCatalog,
} from '../../domain/types'
import { useBusyItem } from '../../hooks/useAsyncAction'
import {
  browseOnlineTitle,
  downloadOnlineTitle,
  errorMessage,
  loadProviderCatalog,
  refreshProvider,
} from '../../native/commands'

type CoverageFilter = 'all' | 'missing' | 'present'

export function OnlineLibrary({
  platform,
  items,
  providers,
  saveProvider,
  removeProvider,
  imported,
}: {
  platform: Platform
  items: MediaItem[]
  providers: OnlineProvider[]
  /** Adds a site, or records a change to one — including a shipped one. */
  saveProvider: (provider: OnlineProvider) => void
  /** Removes the user's own site, or puts a shipped one back as it was. */
  removeProvider: (id: string) => void
  imported: (download: CachedDownload, title: OnlineTitle, provider: OnlineProvider) => void
}) {
  const [providerId, setProviderId] = useState(providers[0]?.id || '')
  const [catalogs, setCatalogs] = useState<Record<string, ProviderCatalog>>({})
  const [query, setQuery] = useState('')
  const [coverage, setCoverage] = useState<CoverageFilter>('missing')
  const [expandedId, setExpandedId] = useState('')
  const [archiveFiles, setArchiveFiles] = useState<Record<string, OnlineTitle[]>>({})
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState('')
  const [addedNotice, setAddedNotice] = useState('')
  const { busyId, error, setError, run } = useBusyItem()

  // Only the sources that apply to the platform being prepared.
  const visible = useMemo(() => providersFor(providers, platform.id), [providers, platform.id])
  const provider = visible.find((entry) => entry.id === providerId) || visible[0]
  const editing = visible.find((entry) => entry.id === editingId)
  const catalog = provider ? catalogs[provider.id] : undefined

  // Cached catalogues load without touching the network, so the coverage
  // comparison still works offline.
  useEffect(() => {
    let active = true
    setError('')
    Promise.all(
      visible.map(
        async (entry) => [entry.id, await loadProviderCatalog(entry.id, platform.id)] as const,
      ),
    )
      .then((loaded) => {
        if (!active) return
        setCatalogs(
          Object.fromEntries(
            loaded.filter((entry): entry is [string, ProviderCatalog] => Boolean(entry[1])),
          ),
        )
      })
      .catch((reason) => active && setError(errorMessage(reason)))
    return () => {
      active = false
    }
  }, [visible, platform.id, setError])

  /** Normalised titles already held locally for this platform. */
  const localKeys = useMemo(
    () =>
      new Set(
        items
          .filter((item) => belongsToPlatform(item, platform.id))
          .flatMap((item) => [
            softwareTitleKey(item.canonicalTitle),
            softwareTitleKey(item.name),
          ])
          .filter(Boolean),
      ),
    [items, platform.id],
  )

  const knownKeys = useMemo(
    () =>
      new Set(
        Object.values(catalogs)
          .flatMap((entry) => entry.items)
          .filter((item) => !item.platformId || item.platformId === platform.id)
          .map((item) => softwareTitleKey(item.title))
          .filter(Boolean),
      ),
    [catalogs, platform.id],
  )

  const presentCount = [...knownKeys].filter((key) => localKeys.has(key)).length

  const rows = (catalog?.items || []).filter((item) => {
    const present = localKeys.has(softwareTitleKey(item.title))
    return (
      (!item.platformId || item.platformId === platform.id) &&
      item.title.toLowerCase().includes(query.trim().toLowerCase()) &&
      (coverage === 'all' || (coverage === 'present') === present)
    )
  })

  const refresh = () =>
    provider &&
    run('refresh', async () => {
      const refreshed = await refreshProvider(
        provider,
        platform.name,
        platform.id,
        platform.formats,
      )
      setCatalogs((current) => ({ ...current, [provider.id]: refreshed }))
    })

  const browse = (title: OnlineTitle) => {
    if (!provider) return
    if (expandedId === title.remoteId) {
      setExpandedId('')
      return
    }
    setExpandedId(title.remoteId)
    if (archiveFiles[title.remoteId]) return
    void run(`browse:${title.remoteId}`, async () => {
      const files = await browseOnlineTitle(provider, title)
      setArchiveFiles((current) => ({ ...current, [title.remoteId]: files }))
    })
  }

  const download = (title: OnlineTitle) =>
    provider &&
    run(title.downloadUrl || title.remoteId, async () => {
      const result = await downloadOnlineTitle(provider, title)
      imported(result, { ...title, platformId: title.platformId || platform.id }, provider)
    })

  return (
    <div className="library-layout">
      <section className="panel library-sidebar online-sources">
        <p className="eyebrow">{platform.name}</p>
        <h3>Online sites</h3>
        {visible.map((entry) => (
          <div
            className={`provider-row ${entry.id === provider?.id ? 'selected' : ''}`}
            key={entry.id}
          >
            <button onClick={() => setProviderId(entry.id)}>
              <Globe2 />
              <span>
                <b>{entry.name}</b>
                <small>
                  {adapterLabel(entry.adapter)} ·{' '}
                  {scopeLabel(entry, (id) => requirePlatform(id).name)}
                  {entry.ignoreRobots ? ' · ignores robots.txt' : ''}
                  {entry.overridden ? ' · changed' : ''}
                </small>
              </span>
            </button>
            <button
              className="edit-provider"
              title={`Settings for ${entry.name}`}
              aria-label={`Settings for ${entry.name}`}
              onClick={() => setEditingId(entry.id)}
            >
              <SlidersHorizontal />
            </button>
            {entry.overridden ? (
              <button
                className="remove-provider"
                title="Put this site back as it shipped"
                aria-label={`Restore ${entry.name}`}
                onClick={() => removeProvider(entry.id)}
              >
                <RotateCcw />
              </button>
            ) : (
              !entry.builtIn && (
                <button
                  className="remove-provider"
                  title="Remove site"
                  aria-label={`Remove ${entry.name}`}
                  onClick={() => removeProvider(entry.id)}
                >
                  <Trash2 />
                </button>
              )
            )}
          </div>
        ))}
        {!visible.length && (
          <p className="mode-note">
            No online sources apply to {platform.name} yet. Add one below, either for this
            machine alone or for every platform.
          </p>
        )}
        <button className="button secondary add-site" onClick={() => setAdding(true)}>
          <Plus />
          Add site
        </button>
        {addedNotice && <InlineStatus kind="success">{addedNotice}</InlineStatus>}
        <div className="provider-note">
          <b>Policy-aware inspection</b>
          <p>
            Website scans stay on the selected host, inspect at most 100 pages, pace
            their requests, and record only supported image links. They obey robots.txt
            unless you have overridden it for a source. Open a source's settings to
            change that; nothing ships with it set.
          </p>
        </div>
      </section>

      <section className="panel library-results">
        <div className="library-toolbar">
          <div>
            <h2>{provider?.name || 'Online library'}</h2>
            <p>
              {catalog
                ? `${rows.length} titles · refreshed ${new Date(
                    catalog.refreshedAt * 1000,
                  ).toLocaleString()}`
                : 'No cached catalogue'}
            </p>
          </div>
          <button
            className="button secondary"
            disabled={!provider || Boolean(busyId)}
            onClick={() => void refresh()}
          >
            <RefreshCw className={busyId === 'refresh' ? 'spinning' : ''} />
            {busyId === 'refresh' ? 'Refreshing' : 'Refresh list'}
          </button>
          <div className="search">
            <Search />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter available titles"
            />
          </div>
        </div>

        <div className="coverage-bar">
          <div className="coverage-summary">
            <span>
              <b>{knownKeys.size}</b> known
            </span>
            <span>
              <b>{presentCount}</b> present
            </span>
            <span>
              <b>{Math.max(0, knownKeys.size - presentCount)}</b> missing
            </span>
          </div>
          <div className="coverage-filter" role="group" aria-label="Collection coverage">
            {(['all', 'missing', 'present'] as const).map((value) => (
              <button
                key={value}
                className={coverage === value ? 'active' : ''}
                onClick={() => setCoverage(value)}
              >
                {value[0].toUpperCase() + value.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {error && <p className="inline-error">{error}</p>}

        <div className="table-wrap">
          <table className="online-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>Format</th>
                <th>Size</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((title) => {
                const present = localKeys.has(softwareTitleKey(title.title))
                const expandable = isBrowsable(provider)
                const downloadable = isDownloadable(provider, title)
                const files = archiveFiles[title.remoteId] || []
                return (
                  <Fragment key={title.remoteId}>
                    <tr>
                      <td>
                        <button
                          className="archive-title"
                          disabled={!expandable || Boolean(busyId)}
                          onClick={() => browse(title)}
                        >
                          {expandable &&
                            (expandedId === title.remoteId ? <ChevronDown /> : <ChevronRight />)}
                          <b>{title.title}</b>
                        </button>
                        <small>{title.license || title.remoteId}</small>
                      </td>
                      <td>
                        <span className={`coverage-state ${present ? 'present' : 'missing'}`}>
                          {present ? 'Present' : 'Missing'}
                        </span>
                      </td>
                      <td>
                        {title.extension
                          ? `.${title.extension}`
                          : downloadable
                            ? 'Resolve on download'
                            : 'Reference only'}
                      </td>
                      <td>{title.size ? formatBytes(title.size) : 'Unknown'}</td>
                      <td>
                        {title.updated ? new Date(title.updated).toLocaleDateString() : ''}
                      </td>
                      <td>
                        <button
                          className="row-action"
                          title={
                            expandable
                              ? 'Browse the files in this archive item'
                              : downloadable
                                ? 'Download and add to this profile'
                                : 'This reference list does not provide a download'
                          }
                          disabled={Boolean(busyId) || !downloadable}
                          onClick={() => (expandable ? browse(title) : void download(title))}
                        >
                          {expandable ? <ChevronRight /> : <Download />}
                        </button>
                      </td>
                    </tr>
                    {expandedId === title.remoteId && (
                      <tr className="archive-contents">
                        <td colSpan={6}>
                          <div className="archive-files">
                            {files.map((file) => (
                              <div key={file.downloadUrl}>
                                <Archive />
                                <span>
                                  <b>{file.title}</b>
                                  <small>
                                    {file.extension ? `.${file.extension}` : 'File'} ·{' '}
                                    {file.size ? formatBytes(file.size) : 'Unknown size'}
                                  </small>
                                </span>
                                <button
                                  className="button secondary"
                                  disabled={Boolean(busyId)}
                                  onClick={() => void download(file)}
                                >
                                  <Download />
                                  Download &amp; add
                                </button>
                              </div>
                            ))}
                            {!files.length && busyId !== `browse:${title.remoteId}` && (
                              <p>No supported files were found in this archive item.</p>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
          {!rows.length && (
            <Empty
              title={catalog ? 'No matching online titles' : 'Refresh this site to load its catalogue'}
              action="Refresh list"
              run={() => void refresh()}
            />
          )}
        </div>
      </section>

      {adding && (
        <SiteDialog
          platform={platform}
          close={() => setAdding(false)}
          save={(added) => {
            saveProvider(added)
            setProviderId(added.id)
            setAdding(false)
            setAddedNotice(`Added ${added.name}. Choose “Refresh list” to load it.`)
          }}
        />
      )}

      {editing && (
        <SiteDialog
          platform={platform}
          existing={editing}
          close={() => setEditingId('')}
          save={(changed) => {
            saveProvider(changed)
            setEditingId('')
            setAddedNotice(`Saved ${changed.name}. Choose “Refresh list” to apply it.`)
          }}
          restore={
            editing.overridden
              ? () => {
                  removeProvider(editing.id)
                  setEditingId('')
                  setAddedNotice(`${editing.name} is back to the settings it shipped with.`)
                }
              : undefined
          }
        />
      )}

      {busyId && (
        <ProgressDialog
          title={
            busyId === 'refresh'
              ? 'Refreshing online catalogue'
              : busyId.startsWith('browse:')
                ? 'Inspecting archive item'
                : 'Downloading title'
          }
          detail={
            busyId === 'refresh'
              ? 'Reading the selected provider and updating the cached catalogue.'
              : busyId.startsWith('browse:')
                ? 'Finding the supported files in this archive item.'
                : 'Caching the download, extracting supported images, and adding them to your library.'
          }
        />
      )}
    </div>
  )
}

/** The fields a source is made of, as one dialog edits them. */
type SiteDraft = {
  name: string
  adapter: ProviderAdapter
  url: string
  query: string
  scope: string
  ignoreRobots: boolean
  userAgent: string
}

/**
 * The adapters a source can be built with by hand.
 *
 * The API adapters are deliberately absent: their query means something
 * particular to one service, so a source using one is a deliberate integration
 * that ships with the application rather than something to be typed in.
 */
const OWN_ADAPTERS: ProviderAdapter[] = ['htmlSite', 'jsonFeed']

const ADAPTER_OPTIONS: Record<ProviderAdapter, string> = {
  htmlSite: 'Inspect website',
  jsonFeed: 'JSON catalogue or known list',
  internetArchive: 'Internet Archive search',
  demozoo: 'Demozoo API',
}

function draftOf(existing: OnlineProvider | undefined, platform: Platform): SiteDraft {
  return {
    name: existing?.name || '',
    adapter: existing?.adapter || 'htmlSite',
    url: existing?.catalogUrl || '',
    query: existing?.query || '',
    // A new source is usually machine-specific, so the platform being prepared
    // is a better default than "everything".
    scope: existing ? existing.platformId || '' : platform.id,
    ignoreRobots: existing?.ignoreRobots || false,
    userAgent: existing?.userAgent || '',
  }
}

/**
 * The source a draft describes.
 *
 * Built on top of the entry being edited so that fields this dialog does not
 * show — a shipped source's note, for one — survive being changed here.
 */
function providerOf(draft: SiteDraft, existing?: OnlineProvider): OnlineProvider {
  return {
    ...existing,
    id: existing?.id || `site-${Date.now()}`,
    name: draft.name.trim(),
    adapter: draft.adapter,
    catalogUrl: draft.url.trim() || undefined,
    query: draft.query.trim() || undefined,
    platformId: draft.scope || undefined,
    ignoreRobots: draft.ignoreRobots || undefined,
    userAgent: draft.userAgent.trim() || undefined,
  }
}

/**
 * Adding a site, and changing one already added — including one that shipped.
 *
 * These were one dialog and one absence, which meant a shipped site could not
 * be adjusted at all: the only way to scan a site that refuses robots was to
 * add a second copy of it by hand. The same fields serve both, because they are
 * the same fields.
 */
function SiteDialog({
  platform,
  existing,
  close,
  save,
  restore,
}: {
  platform: Platform
  existing?: OnlineProvider
  close: () => void
  save: (provider: OnlineProvider) => void
  /** Offered only for a shipped source that has been changed. */
  restore?: () => void
}) {
  const [draft, setDraft] = useState<SiteDraft>(() => draftOf(existing, platform))
  const [confirming, setConfirming] = useState(false)

  const set = <K extends keyof SiteDraft>(key: K, value: SiteDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))

  const candidate = providerOf(draft, existing)
  // The same check the source file is read with, so a hand-typed source and a
  // hand-written one are held to one standard and told the same sentence.
  const fault = draft.name.trim() ? faultIn(candidate, 'This site') : null
  const usesUrl = OWN_ADAPTERS.includes(draft.adapter)
  const adaptable = !existing || OWN_ADAPTERS.includes(existing.adapter)

  return (
    <Modal title={existing ? `Settings for ${existing.name}` : 'Add online site'} onClose={close}>
      {!existing && <p>Add a website to inspect, or a structured reference catalogue.</p>}
      {existing?.builtIn && (
        <p className="mode-note">
          This site ships with the application. Anything you change here is kept
          separately and can be put back.
        </p>
      )}
      <label>
        Site name
        <input value={draft.name} onChange={(event) => set('name', event.target.value)} />
      </label>
      <label>
        Source type
        {adaptable ? (
          <select
            value={draft.adapter}
            onChange={(event) => set('adapter', event.target.value as ProviderAdapter)}
          >
            {OWN_ADAPTERS.map((adapter) => (
              <option key={adapter} value={adapter}>
                {ADAPTER_OPTIONS[adapter]}
              </option>
            ))}
          </select>
        ) : (
          // Changing this would leave a query written for one service being
          // sent to another, so it is shown rather than offered.
          <input readOnly value={ADAPTER_OPTIONS[draft.adapter]} />
        )}
      </label>
      {usesUrl ? (
        <label>
          {draft.adapter === 'htmlSite' ? 'Starting page URL' : 'Catalogue URL'}
          <input
            type="url"
            placeholder={
              draft.adapter === 'htmlSite'
                ? 'https://example.org/software/'
                : 'https://example.org/gotek-catalogue.json'
            }
            value={draft.url}
            onChange={(event) => set('url', event.target.value)}
          />
        </label>
      ) : (
        <label>
          {draft.adapter === 'demozoo' ? 'Demozoo platform number' : 'Archive search'}
          <input value={draft.query} onChange={(event) => set('query', event.target.value)} />
        </label>
      )}
      <label>
        Applies to
        <select value={draft.scope} onChange={(event) => set('scope', event.target.value)}>
          <option value="">All platforms</option>
          {platforms.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>
      <p className="mode-note">
        A source for one machine only appears when that machine is being prepared.
      </p>
      {draft.adapter === 'htmlSite' && (
        <>
          <label className="check-label">
            <input
              type="checkbox"
              checked={draft.ignoreRobots}
              onChange={(event) => {
                // Turning it on asks first; turning it off never needs to.
                if (event.target.checked) setConfirming(true)
                else set('ignoreRobots', false)
              }}
            />
            Ignore this site&rsquo;s robots.txt
          </label>
          <label>
            Identify as
            <input
              value={draft.userAgent}
              placeholder="GoTekManager/0.1 (default)"
              onChange={(event) => set('userAgent', event.target.value)}
            />
          </label>
          <p className="mode-note">
            Left empty, the scan names this application, which is what lets a site
            recognise it and decide for itself.
          </p>
        </>
      )}
      <p className="feed-format">
        {draft.adapter === 'htmlSite' ? (
          <>
            Inspection follows same-site catalogue pages to depth 2 and records direct
            links in this platform&rsquo;s formats.{' '}
            {draft.ignoreRobots
              ? 'This source ignores the site\u2019s robots rules and is paced ten times slower.'
              : 'The site\u2019s robots rules are enforced.'}
          </>
        ) : draft.adapter === 'jsonFeed' ? (
          <>
            Items require <b>remoteId</b> and <b>title</b>. Optional fields are
            downloadUrl, platformId, extension, size, detailsUrl, license, and updated.
            Lists without downloads are used for collection coverage.
          </>
        ) : (
          <>
            This source reads a service API. Its query is what selects the machine, so
            changing it changes which productions are listed.
          </>
        )}
      </p>
      {fault && <p className="inline-error">{fault}.</p>}
      {confirming && (
        <RobotsOverrideWarning
          site={draft.url || 'this site'}
          cancel={() => setConfirming(false)}
          accept={() => {
            set('ignoreRobots', true)
            setConfirming(false)
          }}
        />
      )}
      <div className="flow-actions">
        {restore && (
          <button className="button secondary" onClick={restore}>
            <RotateCcw />
            Restore what shipped
          </button>
        )}
        <button
          className="button"
          disabled={!draft.name.trim() || Boolean(fault)}
          onClick={() => save(candidate)}
        >
          {existing ? <SlidersHorizontal /> : <Plus />}
          {existing ? 'Save changes' : 'Add site'}
        </button>
      </div>
    </Modal>
  )
}

/**
 * Asked before a site's robots.txt is disregarded.
 *
 * Deliberately blunt and deliberately not the default. A `robots.txt` is the
 * operator saying what they want; overriding it is a choice the person at the
 * keyboard makes about their own traffic and their own risk, so it is worth
 * one clear sentence rather than a checkbox nobody reads.
 */
function RobotsOverrideWarning({
  site,
  cancel,
  accept,
}: {
  site: string
  cancel: () => void
  accept: () => void
}) {
  return (
    <Modal title="Ignore this site's robots.txt?" onClose={cancel}>
      <p>
        <code>{site}</code> publishes a <code>robots.txt</code> asking automated tools
        not to read it. Turning this on scans it anyway.
      </p>
      <p className="mode-note">
        Things worth knowing before you do:
      </p>
      <ul className="plan-files">
        <li>
          It may breach the site's terms of use. That is between you and them; this
          application cannot judge it for you.
        </li>
        <li>
          Your address may be rate-limited or blocked, and hobby archives are often run
          by one person paying for the bandwidth.
        </li>
        <li>
          On a storefront, links found this way may point at paid content. Downloading
          it without paying is not something the licence you were offered allows.
        </li>
        <li>
          Scans with this on are paced ten times slower, and stay on the one site, at
          most 100 pages deep.
        </li>
      </ul>
      <div className="flow-actions">
        <button className="button secondary" onClick={cancel}>
          Leave it alone
        </button>
        <button className="button danger" onClick={accept}>
          Scan anyway, at my own risk
        </button>
      </div>
    </Modal>
  )
}
