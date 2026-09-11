/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Pagination,
  PaginationContent,
  PaginationItem,
} from '@/components/ui/pagination'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuthStore } from '@/stores/auth-store'

import { deleteGalleryImage, getGalleryImages, listCanvasRecords } from './api'
import { CanvasCard, type CanvasProjectView } from './components/canvas-card'
import { CanvasProjectDialog } from './components/canvas-project-dialog'
import { CanvasSaveStatus } from './components/canvas-save-status'
import { GalleryImageCard } from './components/gallery-image-card'
import { GalleryPreview } from './components/gallery-preview'
import { useCanvasProjects } from './hooks/use-canvas-projects'
import { readCanvasAssets } from './lib/canvas-repository'
import { checkCanvasCapacity, getCanvasGalleryUsage } from './lib/canvas-sync'
import {
  collectGalleryPages,
  localGalleryImages,
  mergeGalleryImages,
} from './lib/gallery-collection'
import { galleryOwner } from './lib/session'
import type { CanvasKind, GalleryIdentity, GalleryImage } from './types'

export { GallerySettingsSection } from './components/gallery-settings-section'

export function Gallery() {
  const { t } = useTranslation()
  const userId = useAuthStore((state) => state.auth.user?.id ?? null)
  const sessionId = useAuthStore((state) => state.auth.session?.sid ?? null)
  if (userId === null || sessionId === null) {
    return <ErrorState description={t('Session expired!')} />
  }
  return (
    <GalleryContent
      key={`${userId}:${sessionId}`}
      identity={{ userId, sessionId }}
    />
  )
}

function GalleryContent(props: { identity: GalleryIdentity }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const client = useQueryClient()
  const [view, setView] = useState('images')
  const [source, setSource] = useState('all')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('newest')
  const [page, setPage] = useState(1)
  const [preview, setPreview] = useState<GalleryImage | null>(null)
  const [imageDeleteTarget, setImageDeleteTarget] =
    useState<GalleryImage | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CanvasProjectView | null>(
    null
  )
  const [dialog, setDialog] = useState<'create' | 'rename' | null>(null)
  const [renameTarget, setRenameTarget] = useState<CanvasProjectView | null>(
    null
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [removedImages, setRemovedImages] = useState<string[]>([])
  const [removedProjects, setRemovedProjects] = useState<string[]>([])
  const drawing = useCanvasProjects('drawing')
  const nai = useCanvasProjects('nai')
  const localProjects = useMemo(
    () => [...drawing.projects, ...nai.projects],
    [drawing.projects, nai.projects]
  )
  const key = ['gallery', props.identity.userId, props.identity.sessionId]
  const usage = useQuery({
    queryKey: [...key, 'usage'],
    queryFn: ({ signal }) => getCanvasGalleryUsage(props.identity, signal),
    retry: false,
    staleTime: 300_000,
    refetchOnWindowFocus: false,
  })
  const images = useQuery({
    queryKey: [...key, 'images'],
    queryFn: ({ signal }) =>
      collectGalleryPages((page) =>
        getGalleryImages(props.identity, page, undefined, signal)
      ),
    retry: false,
    enabled: view === 'images',
    staleTime: Infinity,
  })
  const canvases = useQuery({
    queryKey: [...key, 'canvases'],
    queryFn: ({ signal }) =>
      collectGalleryPages((page) =>
        listCanvasRecords(props.identity, { page }, signal)
      ),
    retry: false,
    enabled: view === 'canvases',
    staleTime: Infinity,
  })
  const local = useQuery({
    queryKey: [
      ...key,
      'local-assets',
      localProjects.map((item) => `${item.id}:${item.revision}`).join(','),
    ],
    queryFn: async () =>
      Promise.all(
        localProjects.map(async (canvas) => ({
          canvas,
          assets: await readCanvasAssets(
            galleryOwner(props.identity),
            canvas.id
          ),
        }))
      ),
    enabled: !drawing.loading && !nai.loading,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  })
  const hiddenProjects = new Set([
    ...removedProjects,
    ...drawing.pendingCanvasRemovals.map((item) => item.canvasId),
  ])
  const hiddenImages = new Set([
    ...removedImages,
    ...drawing.pendingAssetRemovals.map((item) => item.assetId),
  ])
  const matches = (kind: string, title: string) =>
    (source === 'all' || source === kind) &&
    title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  const projectNames = new Map(
    localProjects.map((project) => [project.id, project.name])
  )
  const imageItems = mergeGalleryImages(
    images.data ?? [],
    (local.data ?? []).flatMap(({ canvas, assets }) =>
      localGalleryImages(canvas, assets)
    )
  )
    .filter(
      (image) =>
        !hiddenImages.has(image.id) &&
        !hiddenProjects.has(image.canvas_id ?? '') &&
        matches(
          image.source,
          `${image.prompt} ${
            image.canvas_name ?? projectNames.get(image.canvas_id ?? '') ?? ''
          }`
        )
    )
    .sort((a, b) =>
      sort === 'name'
        ? a.prompt.localeCompare(b.prompt) || a.id.localeCompare(b.id)
        : (sort === 'oldest'
            ? a.created_at - b.created_at
            : b.created_at - a.created_at) || a.id.localeCompare(b.id)
    )
  const mergedProjects = new Map<string, CanvasProjectView>(
    (canvases.data ?? []).map((canvas) => [
      canvas.id,
      {
        id: canvas.id,
        kind: canvas.kind,
        name: canvas.name,
        revision: canvas.revision,
        state: canvas.state,
        updatedAt: canvas.updated_at,
        expiresAt: canvas.expires_at,
        coverAssetIds: canvas.cover_asset_ids,
      },
    ])
  )
  for (const canvas of localProjects) {
    const assets =
      local.data?.find((item) => item.canvas.id === canvas.id)?.assets ?? []
    const remote = mergedProjects.get(canvas.id)
    mergedProjects.set(canvas.id, {
      id: canvas.id,
      kind: canvas.kind,
      name: canvas.name,
      revision: canvas.revision,
      state: 'ready',
      updatedAt: Math.max(
        remote?.updatedAt ?? 0,
        Math.floor(canvas.localSavedAt / 1000)
      ),
      expiresAt: canvas.expiresAt,
      coverAssetIds: assets
        .filter(
          (asset) =>
            asset.role !== 'mask' && !canvas.removedAssetIds.includes(asset.id)
        )
        .map((asset) => asset.id)
        .slice(0, 4),
      coverBlobs: Object.fromEntries(
        assets.map((asset) => [asset.id, asset.blob])
      ),
      localOnly: !canvas.cloudRevision || canvas.needsExplicitSave,
      status: canvas.status,
    })
  }
  const projects = [...mergedProjects.values()]
    .filter(
      (project) =>
        project.state === 'ready' &&
        !hiddenProjects.has(project.id) &&
        matches(project.kind, project.name)
    )
    .sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
        : (sort === 'oldest'
            ? a.updatedAt - b.updatedAt
            : b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id)
    )
  const activeQuery = view === 'images' ? images : canvases
  const total = view === 'images' ? imageItems.length : projects.length
  const pages = Math.max(1, Math.ceil(total / 24))
  const currentPage = Math.min(page, pages)
  const offset = (currentPage - 1) * 24
  const status = drawing.statusText || nai.statusText
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }
  const refresh = async () => {
    await Promise.all([usage.refetch(), activeQuery.refetch(), local.refetch()])
  }
  const invalidate = async () => {
    await Promise.all(
      ['images', 'canvases', 'usage'].map((part) =>
        client.invalidateQueries({ queryKey: [...key, part] })
      )
    )
  }
  const openProject = (id: string, kind: CanvasKind, image?: string) => {
    void run(async () => {
      await (kind === 'drawing' ? drawing : nai).open(id, image)
      await navigate({
        to: kind === 'drawing' ? '/canvas/drawing' : '/canvas/nai',
        search: { canvas: id, image },
      })
    })
  }
  const submitDialog = (name: string, kind: CanvasKind) => {
    void run(async () => {
      if (dialog === 'create') {
        const canvas = await (kind === 'drawing' ? drawing : nai).create(name)
        setDialog(null)
        await navigate({
          to: kind === 'drawing' ? '/canvas/drawing' : '/canvas/nai',
          search: { canvas: canvas.id },
        })
      } else if (renameTarget) {
        await (renameTarget.kind === 'drawing' ? drawing : nai).rename(
          renameTarget.id,
          name
        )
        setDialog(null)
        setRenameTarget(null)
      }
      await invalidate()
    })
  }
  const confirmDelete = () => {
    if (!deleteTarget) return
    const target = deleteTarget
    void run(async () => {
      await (target.kind === 'drawing' ? drawing : nai).deleteProject(target.id)
      setRemovedProjects((ids) => [...ids, target.id])
      setDeleteTarget(null)
      await invalidate()
    })
  }
  const confirmImageDelete = () => {
    if (!imageDeleteTarget) return
    const image = imageDeleteTarget
    void run(async () => {
      if (image.canvas_id) {
        await (image.source === 'drawing' ? drawing : nai).deleteResource(
          image.canvas_id,
          image.id
        )
      } else {
        await deleteGalleryImage(props.identity, image.id)
        await checkCanvasCapacity(props.identity, true)
      }
      setRemovedImages((ids) => [...ids, image.id])
      setImageDeleteTarget(null)
      setPreview(null)
      await invalidate()
    })
  }
  const loading =
    (activeQuery.isPending && !total) ||
    drawing.loading ||
    nai.loading ||
    local.isPending
  return (
    <main
      id='content'
      className='flex h-full min-h-0 flex-col gap-5 overflow-y-auto p-4 sm:p-6'
    >
      <header className='flex flex-wrap items-start justify-between gap-3'>
        <div className='flex min-w-0 flex-col gap-1'>
          <h1 className='text-2xl font-semibold'>{t('My Gallery')}</h1>
          <p className='text-muted-foreground text-sm'>
            {t(
              'Private final images from Drawing and NAI Canvas. Both sources share one quota.'
            )}
          </p>
          {status ? (
            <CanvasSaveStatus
              localStatus='saved'
              cloudStatus='full'
              statusText={status}
            />
          ) : null}
        </div>
        <div className='flex gap-2'>
          <Button
            variant='outline'
            onClick={() => void run(refresh)}
            disabled={busy}
          >
            {t('Refresh')}
          </Button>
          <Button
            onClick={() => {
              setRenameTarget(null)
              setDialog('create')
            }}
            disabled={busy}
          >
            {t('New canvas')}
          </Button>
        </div>
      </header>
      {usage.data ? (
        <section
          aria-label={t('Gallery usage')}
          className='rounded-lg border p-4 text-sm'
        >
          <div className='flex flex-wrap justify-between gap-2'>
            <span>
              {t('{{used}} / {{max}} images', {
                used: usage.data.used_images,
                max: usage.data.max_images,
              })}
            </span>
            <span>
              {(usage.data.used_bytes / 1048576).toFixed(2)} /{' '}
              {(usage.data.max_bytes / 1048576).toFixed(2)} MiB
            </span>
          </div>
          <p className='text-muted-foreground mt-2'>
            {t(
              'New images expire after {{days}} days. Originals, thumbnails and metadata all count toward storage.',
              { days: usage.data.retention_days }
            )}
          </p>
          <p className='text-muted-foreground mt-1'>
            {t(
              'References count as originals. Thumbnails, masks and canvas documents share the byte quota. Cloud expiry keeps local drafts.'
            )}
          </p>
        </section>
      ) : null}
      {error ? (
        <Alert variant='destructive'>
          <AlertDescription>{t(error)}</AlertDescription>
        </Alert>
      ) : null}
      {activeQuery.isError || usage.isError || local.isError ? (
        <ErrorState
          description={t('Gallery could not be loaded.')}
          onRetry={() => void run(refresh)}
        />
      ) : null}
      <Tabs
        value={view}
        onValueChange={(value) => {
          setView(value)
          setPage(1)
        }}
      >
        <div className='flex flex-wrap items-center justify-between gap-3'>
          <TabsList>
            <TabsTrigger value='images'>{t('Images')}</TabsTrigger>
            <TabsTrigger value='canvases'>{t('Canvases')}</TabsTrigger>
          </TabsList>
          <div className='flex min-w-0 flex-wrap gap-2'>
            <Input
              className='w-full sm:w-64'
              value={search}
              onChange={(event) => {
                setSearch(event.target.value)
                setPage(1)
              }}
              placeholder={t('Search')}
              aria-label={t('Search')}
            />
            <Select
              value={source}
              onValueChange={(value) => {
                setSource(value ?? 'all')
                setPage(1)
              }}
            >
              <SelectTrigger aria-label={t('Source')}>
                <SelectValue>
                  {
                    {
                      all: t('All'),
                      drawing: t('Drawing'),
                      nai: t('NAI Canvas'),
                    }[source]
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value='all'>{t('All')}</SelectItem>
                  <SelectItem value='drawing'>{t('Drawing')}</SelectItem>
                  <SelectItem value='nai'>{t('NAI Canvas')}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select
              value={sort}
              onValueChange={(value) => {
                setSort(value ?? 'newest')
                setPage(1)
              }}
            >
              <SelectTrigger aria-label={t('Sort')}>
                <SelectValue>
                  {
                    {
                      newest: t('Newest'),
                      oldest: t('Oldest'),
                      name: t('Name'),
                    }[sort]
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value='newest'>{t('Newest')}</SelectItem>
                  <SelectItem value='oldest'>{t('Oldest')}</SelectItem>
                  <SelectItem value='name'>{t('Name')}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </div>
        <TabsContent value='images'>
          {loading && <LoadingState />}
          {!loading && imageItems.length > 0 && (
            <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'>
              {imageItems.slice(offset, offset + 24).map((image) => (
                <GalleryImageCard
                  key={image.id}
                  image={image}
                  identity={props.identity}
                  onPreview={() => setPreview(image)}
                  onDelete={() => setImageDeleteTarget(image)}
                  onOpenCanvas={
                    image.canvas_id
                      ? () => {
                          if (image.canvas_id)
                            openProject(image.canvas_id, image.source, image.id)
                        }
                      : undefined
                  }
                />
              ))}
            </div>
          )}
          {!loading && !imageItems.length && !activeQuery.isError && (
            <EmptyState
              title={t('No saved images')}
              description={t(
                'New final canvas images will appear here automatically.'
              )}
            />
          )}
        </TabsContent>
        <TabsContent value='canvases'>
          {loading && <LoadingState />}
          {!loading && projects.length > 0 && (
            <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3'>
              {projects.slice(offset, offset + 24).map((project) => (
                <CanvasCard
                  key={project.id}
                  identity={props.identity}
                  project={project}
                  onOpen={() => openProject(project.id, project.kind)}
                  onRename={() => {
                    setRenameTarget(project)
                    setDialog('rename')
                  }}
                  onDelete={() => setDeleteTarget(project)}
                />
              ))}
            </div>
          )}
          {!loading && !projects.length && !activeQuery.isError && (
            <EmptyState
              title={t('No canvases')}
              description={t('Create a canvas to start saving your work.')}
            />
          )}
        </TabsContent>
      </Tabs>
      <Pagination aria-label={t('Pagination')}>
        <PaginationContent>
          <PaginationItem>
            <Button
              variant='outline'
              aria-label={t('Go to previous page')}
              disabled={currentPage <= 1}
              onClick={() => setPage(currentPage - 1)}
            >
              {t('Previous')}
            </Button>
          </PaginationItem>
          <PaginationItem>
            <span className='px-3 text-sm'>
              {currentPage} / {pages}
            </span>
          </PaginationItem>
          <PaginationItem>
            <Button
              variant='outline'
              aria-label={t('Go to next page')}
              disabled={currentPage >= pages}
              onClick={() => setPage(currentPage + 1)}
            >
              {t('Next')}
            </Button>
          </PaginationItem>
        </PaginationContent>
      </Pagination>
      {preview ? (
        <GalleryPreview
          key={preview.id}
          image={preview}
          identity={props.identity}
          onClose={() => setPreview(null)}
        />
      ) : null}
      <CanvasProjectDialog
        open={dialog !== null}
        mode={dialog ?? 'create'}
        initialName={renameTarget?.name}
        initialKind={renameTarget?.kind}
        busy={busy}
        error={error}
        onOpenChange={(open) => {
          if (!open) {
            setDialog(null)
            setRenameTarget(null)
          }
        }}
        onSubmit={submitDialog}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title={t('Delete canvas')}
        desc={t('The canvas and its images will be deleted.')}
        destructive
        isLoading={busy}
        confirmText={t('Delete')}
        handleConfirm={confirmDelete}
      >
        {error ? <p role='alert'>{t(error)}</p> : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={imageDeleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setImageDeleteTarget(null)
        }}
        title={t('Delete image')}
        desc={t('This image will be removed from the gallery and its canvas.')}
        destructive
        isLoading={busy}
        confirmText={t('Delete')}
        handleConfirm={confirmImageDelete}
      >
        {error ? <p role='alert'>{t(error)}</p> : null}
      </ConfirmDialog>
    </main>
  )
}
