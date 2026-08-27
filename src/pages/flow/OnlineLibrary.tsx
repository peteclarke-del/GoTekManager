import { Fragment, useEffect, useMemo, useState } from 'react'
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Download,
  Globe2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react'
import { Empty, InlineStatus, ProgressDialog } from '../../components/Feedback'
import { Modal } from '../../components/Modal'
import { platforms, requirePlatform, type Platform } from '../../domain/catalog'
import { belongsToPlatform, formatBytes, softwareTitleKey } from '../../domain/media'
import {
  adapterLabel,
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
  addProvider,
  removeProvider,
  imported,
}: {
  platform: Platform
  items: MediaItem[]
  providers: OnlineProvider[]
  addProvider: (provider: OnlineProvider) => void
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
  const [addedNotice, setAddedNotice] = useState('')
  const { busyId, error, setError, run } = useBusyItem()

  // Only the sources that apply to the platform being prepared.
  const visible = useMemo(() => providersFor(providers, platform.id), [providers, platform.id])
  const provider = visible.find((entry) => entry.id === providerId) || visible[0]
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
                </small>
              </span>
            </button>
            {!entry.builtIn && (
              <button
                className="remove-provider"
                title="Remove site"
                onClick={() => removeProvider(entry.id)}
              >
                <Trash2 />
              </button>
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
            Website scans stay on the selected host, obey robots.txt, inspect at most
            100 pages, pace their requests, and record only supported image links.
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
        <AddSiteDialog
          platform={platform}
          close={() => setAdding(false)}
          add={(added) => {
            addProvider(added)
            setProviderId(added.id)
            setAdding(false)
            setAddedNotice(`Added ${added.name}. Choose “Refresh list” to load it.`)
          }}
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

function AddSiteDialog({
  platform,
  close,
  add,
}: {
  platform: Platform
  close: () => void
  add: (provider: OnlineProvider) => void
}) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [adapter, setAdapter] = useState<'htmlSite' | 'jsonFeed'>('htmlSite')
  // Most sources are machine-specific, so the platform being prepared is the
  // sensible default rather than "everything".
  const [scope, setScope] = useState<string>(platform.id)
  const valid = name.trim().length > 0 && url.startsWith('https://')

  return (
    <Modal title="Add online site" onClose={close}>
      <p>Add a website to inspect, or a structured reference catalogue.</p>
      <label>
        Site name
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        Source type
        <select
          value={adapter}
          onChange={(event) => setAdapter(event.target.value as 'htmlSite' | 'jsonFeed')}
        >
          <option value="htmlSite">Inspect website</option>
          <option value="jsonFeed">JSON catalogue or known list</option>
        </select>
      </label>
      <label>
        Applies to
        <select value={scope} onChange={(event) => setScope(event.target.value)}>
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
      <label>
        {adapter === 'htmlSite' ? 'Starting page URL' : 'Catalogue URL'}
        <input
          type="url"
          placeholder={
            adapter === 'htmlSite'
              ? 'https://example.org/software/'
              : 'https://example.org/gotek-catalogue.json'
          }
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <p className="feed-format">
        {adapter === 'htmlSite' ? (
          <>
            Inspection follows same-site catalogue pages to depth 2 and records direct
            links in this platform's formats. The site's robots rules are enforced.
          </>
        ) : (
          <>
            Items require <b>remoteId</b> and <b>title</b>. Optional fields are
            downloadUrl, platformId, extension, size, detailsUrl, license, and updated.
            Lists without downloads are used for collection coverage.
          </>
        )}
      </p>
      {url.length > 0 && !url.startsWith('https://') && (
        <p className="inline-error">Online sources must use an HTTPS address.</p>
      )}
      <button
        className="button"
        disabled={!valid}
        onClick={() =>
          add({
            id: `site-${Date.now()}`,
            name: name.trim(),
            adapter,
            catalogUrl: url.trim(),
            platformId: scope || undefined,
          })
        }
      >
        <Plus />
        Add site
      </button>
    </Modal>
  )
}
