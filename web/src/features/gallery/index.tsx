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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getCoreRowModel,
  useReactTable,
  type PaginationState,
} from '@tanstack/react-table'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { DataTableCardGrid, DataTablePagination } from '@/components/data-table'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useAuthStore } from '@/stores/auth-store'

import { deleteGalleryImage, getGalleryImages, getGalleryUsage } from './api'
import { GalleryImageCard } from './components/gallery-image-card'
import { GalleryPreview } from './components/gallery-preview'
import { galleryErrorMessage } from './lib/errors'
import type { GalleryIdentity, GalleryImage, GallerySource } from './types'

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
  const client = useQueryClient()
  const [source, setSource] = useState<GallerySource | undefined>()
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 24,
  })
  const [preview, setPreview] = useState<GalleryImage | null>(null)
  const [deleting, setDeleting] = useState<GalleryImage | null>(null)
  const queryKey = ['gallery', props.identity.userId, props.identity.sessionId]
  const usage = useQuery({
    queryKey: [...queryKey, 'usage'],
    queryFn: ({ signal }) => getGalleryUsage(props.identity, signal),
    retry: false,
    refetchInterval: 30_000,
  })
  const list = useQuery({
    queryKey: [...queryKey, 'images', pagination.pageIndex, source],
    queryFn: ({ signal }) =>
      getGalleryImages(
        props.identity,
        pagination.pageIndex + 1,
        source,
        signal
      ),
    retry: false,
    refetchInterval: 30_000,
  })
  const deletion = useMutation({
    mutationFn: (id: string) => deleteGalleryImage(props.identity, id),
    onSuccess: () => {
      setDeleting(null)
      setPreview(null)
      if (list.data?.items.length === 1 && pagination.pageIndex > 0) {
        setPagination((value) => ({ ...value, pageIndex: value.pageIndex - 1 }))
      }
      void client.invalidateQueries({ queryKey })
    },
    onError: (error) => toast.error(t(galleryErrorMessage(error))),
  })
  const table = useReactTable({
    data: list.data?.items ?? [],
    columns: [],
    getCoreRowModel: getCoreRowModel(),
    getRowId: (item) => item.id,
    manualPagination: true,
    rowCount: list.data?.total ?? 0,
    state: { pagination },
    onPaginationChange: setPagination,
  })
  const refresh = () => {
    void list.refetch()
    void usage.refetch()
  }
  return (
    <main
      id='content'
      className='flex h-full min-h-0 flex-col gap-5 overflow-y-auto p-4 sm:p-6'
    >
      <header className='flex flex-wrap items-start justify-between gap-3'>
        <div className='flex flex-col gap-1'>
          <h1 className='text-2xl font-semibold'>{t('My Gallery')}</h1>
          <p className='text-muted-foreground text-sm'>
            {t(
              'Private final images from Drawing and NAI Canvas. Both sources share one quota.'
            )}
          </p>
        </div>
        <Button
          variant='outline'
          onClick={refresh}
          disabled={list.isFetching || usage.isFetching}
        >
          {t('Refresh')}
        </Button>
      </header>
      {usage.data ? (
        <section
          aria-label={t('Gallery usage')}
          className='flex flex-col gap-2 rounded-lg border p-4 text-sm'
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
          <Progress
            aria-label={t('Gallery usage')}
            value={Math.min(
              100,
              Math.max(
                usage.data.used_images / usage.data.max_images,
                usage.data.used_bytes / usage.data.max_bytes
              ) * 100
            )}
          />
          <p className='text-muted-foreground'>
            {t(
              'New images expire after {{days}} days. Originals, thumbnails and metadata all count toward storage.',
              { days: usage.data.retention_days }
            )}
          </p>
          {!usage.data.can_save ? (
            <Alert>
              <AlertDescription>
                {t(usage.data.reason || 'Gallery storage limit reached.')}
              </AlertDescription>
            </Alert>
          ) : null}
        </section>
      ) : null}
      <ToggleGroup
        value={[source ?? 'all']}
        onValueChange={(values) => {
          const selected = values[0]
          if (!selected) return
          setSource(
            selected === 'all' ? undefined : (selected as GallerySource)
          )
          setPagination({ pageIndex: 0, pageSize: 24 })
        }}
        aria-label={t('Source')}
        variant='outline'
      >
        <ToggleGroupItem value='all'>{t('All')}</ToggleGroupItem>
        <ToggleGroupItem value='drawing'>{t('Drawing')}</ToggleGroupItem>
        <ToggleGroupItem value='nai'>{t('NAI Canvas')}</ToggleGroupItem>
      </ToggleGroup>
      {list.isPending || usage.isPending ? <LoadingState /> : null}
      {list.isError || usage.isError ? (
        <ErrorState
          description={t('Gallery could not be loaded.')}
          onRetry={refresh}
        />
      ) : null}
      {!list.isPending && !list.isError ? (
        <>
          <DataTableCardGrid
            table={table}
            emptyTitle={t('No saved images')}
            emptyDescription={t(
              'New final canvas images will appear here automatically.'
            )}
            gridClassName='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
            renderCard={(row) => (
              <GalleryImageCard
                image={row.original}
                identity={props.identity}
                onPreview={() => setPreview(row.original)}
                onDelete={() => setDeleting(row.original)}
              />
            )}
          />
          <DataTablePagination table={table} compact />
        </>
      ) : null}
      {preview ? (
        <GalleryPreview
          key={preview.id}
          image={preview}
          identity={props.identity}
          onClose={() => setPreview(null)}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !deletion.isPending) setDeleting(null)
        }}
        title={t('Delete gallery image?')}
        desc={t(
          'The saved original and thumbnail will be deleted. Your canvas image is unchanged.'
        )}
        destructive
        confirmText={t('Delete')}
        isLoading={deletion.isPending}
        handleConfirm={() => {
          if (deleting) deletion.mutate(deleting.id)
        }}
      />
    </main>
  )
}
