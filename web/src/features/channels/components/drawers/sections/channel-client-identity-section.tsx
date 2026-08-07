/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { useMemo } from 'react'
import { useWatch, type Control, type UseFormSetValue } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'

import {
  getClientIdentityVersions,
  refreshClientIdentityVersions,
  type ClientIdentityVersionLookup,
} from '../../../api'
import {
  CLIENT_IDENTITY_CHANNEL_TYPES,
  CLIENT_IDENTITY_DEFAULTS,
  type ChannelFormValues,
} from '../../../lib/channel-form'
import type {
  ClientIdentityPlatform,
  ClientIdentityProfile,
} from '../../../types'

type ChannelClientIdentitySectionProps = {
  control: Control<ChannelFormValues>
  setValue: UseFormSetValue<ChannelFormValues>
  channelType: number
  disabled: boolean
  isSubmitting: boolean
}

const PLATFORM_OPTIONS: Array<{
  value: ClientIdentityPlatform
  label: string
}> = [
  { value: 'windows-x64', label: 'Windows x64' },
  { value: 'macos-x64', label: 'macOS x64' },
  { value: 'macos-arm64', label: 'macOS arm64' },
  { value: 'linux-x64', label: 'Linux x64' },
  { value: 'linux-arm64', label: 'Linux arm64' },
]

const PROFILE_LABELS: Record<ClientIdentityProfile, string> = {
  codex_legacy: 'Codex (legacy)',
  codex_compatibility: 'Codex',
  claude_code: 'Claude Code',
  codebuddy: 'WorkBuddy',
}

function getDefaultProfile(channelType: number): ClientIdentityProfile {
  return CLIENT_IDENTITY_DEFAULTS[channelType]?.profile as ClientIdentityProfile
}

function getDefaultClientType(channelType: number): string {
  return CLIENT_IDENTITY_DEFAULTS[channelType]?.client_type || ''
}

function getClientTypeLabel(clientType: string, t: TFunction): string {
  switch (clientType) {
    case 'codex':
      return t('Codex')
    case 'claude_code':
      return t('Claude Code')
    default:
      return t('WorkBuddy')
  }
}

function getVersionQueryKey(
  profile: ClientIdentityProfile,
  platform: ClientIdentityPlatform | undefined
) {
  return [
    'channels',
    'client-identity-versions',
    profile,
    platform || 'default',
  ]
}

function unwrapLookup(response: {
  success: boolean
  data?: ClientIdentityVersionLookup
  message?: string
}): ClientIdentityVersionLookup {
  if (!response.success || !response.data) {
    throw new Error(response.message || 'Failed to load client versions')
  }
  return response.data
}

export function ChannelClientIdentitySection(
  props: ChannelClientIdentitySectionProps
) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const supported = CLIENT_IDENTITY_CHANNEL_TYPES.has(props.channelType)
  const defaultProfile = getDefaultProfile(props.channelType)
  const defaultClientType = getDefaultClientType(props.channelType)
  const profile = useWatch({
    control: props.control,
    name: 'client_identity_profile',
  })
  const version = useWatch({
    control: props.control,
    name: 'client_identity_version',
  })
  const platform = useWatch({
    control: props.control,
    name: 'client_identity_platform',
  })
  const effectiveProfile = (
    profile === defaultProfile ? profile : defaultProfile
  ) as ClientIdentityProfile
  const effectivePlatform = platform as ClientIdentityPlatform | undefined
  const queryKey = useMemo(
    () => getVersionQueryKey(effectiveProfile, effectivePlatform),
    [effectivePlatform, effectiveProfile]
  )
  const versionsQuery = useQuery({
    queryKey,
    enabled: supported && Boolean(effectiveProfile),
    queryFn: async () =>
      unwrapLookup(
        await getClientIdentityVersions(effectiveProfile, effectivePlatform)
      ),
  })
  const refreshMutation = useMutation({
    mutationFn: async () =>
      unwrapLookup(
        await refreshClientIdentityVersions(effectiveProfile, effectivePlatform)
      ),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data)
      toast.success(t('Client versions refreshed'))
    },
    onError: () => {
      toast.error(t('Failed to refresh client versions'))
    },
  })

  if (!supported) return null

  const lookup = versionsQuery.data
  const versionOptions = lookup?.versions || []
  const selectedVersion = version?.trim() || ''
  const hasSelectedVersion = Boolean(
    selectedVersion && versionOptions.includes(selectedVersion)
  )
  const displayVersion = hasSelectedVersion ? selectedVersion : 'default'
  const selectedPlatform = platform || 'default'

  return (
    <div className='flex scroll-mt-4 flex-col gap-4 border-t pt-4'>
      <div className='flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between'>
        <div className='flex items-start gap-3'>
          <span className='bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-md'>
            <ShieldCheck className='h-4 w-4' aria-hidden='true' />
          </span>
          <div className='space-y-1'>
            <h3 className='text-sm font-semibold'>
              {t('Client Identity & Version')}
            </h3>
            <p className='text-muted-foreground text-xs'>
              {t(
                'Configure the client identity used by this compatibility channel.'
              )}
            </p>
          </div>
        </div>
        <Button
          type='button'
          variant='outline'
          size='sm'
          disabled={
            props.disabled ||
            props.isSubmitting ||
            versionsQuery.isPending ||
            refreshMutation.isPending
          }
          onClick={() => refreshMutation.mutate()}
        >
          {refreshMutation.isPending ? (
            <Loader2 className='mr-2 h-4 w-4 animate-spin' aria-hidden='true' />
          ) : (
            <RefreshCw className='mr-2 h-4 w-4' aria-hidden='true' />
          )}
          {t('Refresh client versions')}
        </Button>
      </div>

      <div className='grid gap-4 sm:grid-cols-2'>
        <FormField
          control={props.control}
          name='client_identity_client_type'
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('Client identity')}</FormLabel>
              <Select
                value={field.value || defaultClientType}
                onValueChange={field.onChange}
                disabled={props.disabled || props.isSubmitting}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder={t('Client identity')} />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={defaultClientType}>
                      {getClientTypeLabel(defaultClientType, t)}
                    </SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FormDescription>
                {t('Client identity is determined by channel type.')}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={props.control}
          name='client_identity_profile'
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('Client profile')}</FormLabel>
              <Select
                value={field.value || defaultProfile}
                onValueChange={field.onChange}
                disabled={props.disabled || props.isSubmitting}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder={t('Client profile')} />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={defaultProfile}>
                      {t(PROFILE_LABELS[defaultProfile])}
                    </SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FormDescription>
                {t(
                  'Codex legacy and Codex compatibility remain separate profiles.'
                )}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={props.control}
          name='client_identity_version'
          render={() => (
            <FormItem>
              <FormLabel>{t('Client version')}</FormLabel>
              <Select
                value={displayVersion}
                onValueChange={(value) =>
                  props.setValue(
                    'client_identity_version',
                    value === 'default' || value == null ? '' : value,
                    { shouldDirty: true, shouldValidate: true }
                  )
                }
                disabled={
                  props.disabled ||
                  props.isSubmitting ||
                  versionsQuery.isPending
                }
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue
                      placeholder={t('Use default client version')}
                    />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value='default'>
                      {t('Use default client version')}
                    </SelectItem>
                    {selectedVersion && !hasSelectedVersion && (
                      <SelectItem value={selectedVersion}>
                        {selectedVersion} ({t('retained selection')})
                      </SelectItem>
                    )}
                    {versionOptions.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FormDescription>
                {lookup?.latest
                  ? t('Latest official version: {{version}}', {
                      version: lookup.latest,
                    })
                  : t('Versions are loaded from the official client source.')}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={props.control}
          name='client_identity_platform'
          render={() => (
            <FormItem>
              <FormLabel>{t('Client platform')}</FormLabel>
              <Select
                value={selectedPlatform}
                onValueChange={(value) =>
                  props.setValue(
                    'client_identity_platform',
                    value === 'default'
                      ? undefined
                      : (value as ClientIdentityPlatform),
                    { shouldDirty: true, shouldValidate: true }
                  )
                }
                disabled={props.disabled || props.isSubmitting}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue
                      placeholder={t('Use default client platform')}
                    />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value='default'>
                      {t('Use default client platform')}
                    </SelectItem>
                    {PLATFORM_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {t(option.label)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FormDescription>
                {t('Platform changes the compatible client identity headers.')}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      {versionsQuery.isPending && <Skeleton className='h-4 w-72' />}
      {versionsQuery.isError && (
        <Alert variant='destructive'>
          <AlertDescription>
            {t('Failed to load client versions')}: {versionsQuery.error.message}
          </AlertDescription>
        </Alert>
      )}
      {lookup && (
        <div className='text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs'>
          <span>
            {t('Source')}: {lookup.source.kind === 'npm' ? 'npm' : 'WorkBuddy'}
          </span>
          {lookup.cached && (
            <span>
              {lookup.stale ? t('Retained cached version') : t('Cached')}
            </span>
          )}
          {!lookup.cached && <span>{t('Official source checked')}</span>}
        </div>
      )}
    </div>
  )
}
