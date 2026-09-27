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
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import * as z from 'zod'

import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { getEnabledModels } from '@/features/channels/api'
import { filterImageModels } from '@/features/playground/drawing/lib/image-models'
import { IMAGE_RESOLUTIONS } from '@/features/playground/drawing/lib/image-settings'
import { getGroups } from '@/features/users/api'
import { requireServerSuccess } from '@/lib/server-error-message'

import { SettingsForm } from '../components/settings-form-layout'
import { SettingsPageFormActions } from '../components/settings-page-context'
import { SettingsSection } from '../components/settings-section'
import { useResetForm } from '../hooks/use-reset-form'
import { useUpdateOption } from '../hooks/use-update-option'
import { safeJsonParse } from '../utils/json-parser'

const DEFAULT_MODELS_KEY = 'canvas_setting.default_models'
const DISABLED_RESOLUTIONS_KEY = 'canvas_setting.disabled_resolutions'

type CanvasOptionKey =
  | typeof DEFAULT_MODELS_KEY
  | typeof DISABLED_RESOLUTIONS_KEY

const canvasSchema = z.object({
  rows: z.array(
    z.object({
      group: z.string(),
      defaultModel: z.string(),
      // Every group keeps at least one tier, as the server requires.
      disabledResolutions: z
        .array(z.enum(IMAGE_RESOLUTIONS))
        .max(IMAGE_RESOLUTIONS.length - 1),
    })
  ),
})

type CanvasFormValues = z.infer<typeof canvasSchema>

/** The two saved options the rows stand for, with groups in row order. */
function canvasOptionValues(
  rows: CanvasFormValues['rows']
): Record<CanvasOptionKey, string> {
  const defaultModels: Record<string, string> = {}
  const disabledResolutions: Record<string, string[]> = {}
  for (const row of rows) {
    if (row.defaultModel) defaultModels[row.group] = row.defaultModel
    if (row.disabledResolutions.length) {
      disabledResolutions[row.group] = IMAGE_RESOLUTIONS.filter((tier) =>
        row.disabledResolutions.includes(tier)
      )
    }
  }
  return {
    [DEFAULT_MODELS_KEY]: JSON.stringify(defaultModels),
    [DISABLED_RESOLUTIONS_KEY]: JSON.stringify(disabledResolutions),
  }
}

type CanvasSettingsSectionProps = {
  /** The saved `canvas_setting.default_models` option. */
  defaultModels: string
  /** The saved `canvas_setting.disabled_resolutions` option. */
  disabledResolutions: string
}

export function CanvasSettingsSection(props: CanvasSettingsSectionProps) {
  const groups = useQuery({
    queryKey: ['groups'],
    queryFn: async () => requireServerSuccess(await getGroups()),
    staleTime: 5 * 60 * 1000,
  })
  const enabledModels = useQuery({
    queryKey: ['enabled-models'],
    queryFn: async () => requireServerSuccess(await getEnabledModels()),
  })
  // A new canvas starts in description mode and only takes a default made
  // for it, so models prompted with tags are left out.
  const imageModels = useMemo(
    () =>
      filterImageModels(
        (enabledModels.data?.data ?? []).map((model) => ({
          value: model,
          label: model,
        })),
        'description'
      )
        .map((option) => option.value)
        .sort((a, b) => a.localeCompare(b)),
    [enabledModels.data]
  )
  if (groups.isPending || enabledModels.isPending) return <LoadingState />
  if (!groups.data || !enabledModels.data) {
    return (
      <ErrorState
        onRetry={() => {
          void groups.refetch()
          void enabledModels.refetch()
        }}
      />
    )
  }
  return (
    <CanvasSettingsForm
      groups={groups.data.data ?? []}
      imageModels={imageModels}
      defaultModels={props.defaultModels}
      disabledResolutions={props.disabledResolutions}
    />
  )
}

type CanvasSettingsFormProps = CanvasSettingsSectionProps & {
  groups: string[]
  imageModels: string[]
}

function CanvasSettingsForm(props: CanvasSettingsFormProps) {
  const { t } = useTranslation()
  const updateOption = useUpdateOption()
  const formDefaults = useMemo<CanvasFormValues>(() => {
    const defaultModels =
      safeJsonParse<Record<string, string> | null>(props.defaultModels, {
        context: DEFAULT_MODELS_KEY,
      }) ?? {}
    const disabledResolutions =
      safeJsonParse<Record<string, string[]> | null>(
        props.disabledResolutions,
        { context: DISABLED_RESOLUTIONS_KEY }
      ) ?? {}
    // A group that is gone keeps its row while it still holds a setting, so
    // the setting can be cleared.
    const groups = [
      ...new Set([
        ...props.groups,
        ...Object.keys(defaultModels),
        ...Object.keys(disabledResolutions),
      ]),
    ].sort((a, b) => a.localeCompare(b))
    return {
      rows: groups.map((group) => ({
        group,
        defaultModel: defaultModels[group] ?? '',
        disabledResolutions: IMAGE_RESOLUTIONS.filter((tier) =>
          disabledResolutions[group]?.includes(tier)
        ),
      })),
    }
  }, [props.groups, props.defaultModels, props.disabledResolutions])
  const form = useForm<CanvasFormValues>({
    resolver: zodResolver(canvasSchema),
    defaultValues: formDefaults,
  })
  useResetForm(form, formDefaults)
  const rows = useWatch({ control: form.control, name: 'rows' }) ?? []

  const onSubmit = async (values: CanvasFormValues) => {
    const saved = canvasOptionValues(formDefaults.rows)
    const next = canvasOptionValues(values.rows)
    const keys: CanvasOptionKey[] = [
      DEFAULT_MODELS_KEY,
      DISABLED_RESOLUTIONS_KEY,
    ]
    for (const key of keys) {
      if (next[key] === saved[key]) continue
      await updateOption.mutateAsync({ key, value: next[key] })
    }
  }

  return (
    <SettingsSection title={t('Canvas management')}>
      <SettingsForm onSubmit={form.handleSubmit(onSubmit)}>
        <SettingsPageFormActions
          onSave={form.handleSubmit(onSubmit)}
          isSaving={updateOption.isPending}
          saveLabel='Save canvas settings'
        />
        <div className='text-muted-foreground flex flex-col gap-1 text-sm'>
          <p>
            {t(
              'For each user group, set the model a canvas picks when it has no usable model selected, and the resolution tiers it offers. A model already selected on a canvas stays selected.'
            )}
          </p>
          <p>
            {t(
              'A tier turned off is only hidden in the canvas; API requests are not limited. Each group keeps at least one tier.'
            )}
          </p>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope='col'>{t('User group')}</TableHead>
              <TableHead scope='col'>{t('Default model')}</TableHead>
              {IMAGE_RESOLUTIONS.map((tier) => (
                <TableHead key={tier} scope='col' className='text-center'>
                  {tier}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, index) => {
              // A saved model that is no longer an enabled image model stays
              // listed, so the select shows what is really saved.
              const savedModel =
                formDefaults.rows.find((saved) => saved.group === row.group)
                  ?.defaultModel ?? ''
              const savedModelUnavailable =
                savedModel !== '' && !props.imageModels.includes(savedModel)
              return (
                <TableRow key={row.group}>
                  <TableHead scope='row'>{row.group}</TableHead>
                  <TableCell>
                    <NativeSelect
                      aria-label={t('Default model for {{group}}', {
                        group: row.group,
                      })}
                      className='w-full min-w-28 sm:min-w-48'
                      {...form.register(`rows.${index}.defaultModel`)}
                    >
                      <NativeSelectOption value=''>
                        {t('Automatic')}
                      </NativeSelectOption>
                      {savedModelUnavailable && (
                        <NativeSelectOption value={savedModel}>
                          {t('{{model}} (unavailable)', { model: savedModel })}
                        </NativeSelectOption>
                      )}
                      {props.imageModels.map((model) => (
                        <NativeSelectOption key={model} value={model}>
                          {model}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </TableCell>
                  {IMAGE_RESOLUTIONS.map((tier) => {
                    const offered = !row.disabledResolutions.includes(tier)
                    const lastOffered =
                      offered &&
                      row.disabledResolutions.length ===
                        IMAGE_RESOLUTIONS.length - 1
                    return (
                      <TableCell key={tier} className='text-center'>
                        <Switch
                          aria-label={t('Offer {{resolution}} to {{group}}', {
                            resolution: tier,
                            group: row.group,
                          })}
                          checked={offered}
                          disabled={lastOffered}
                          onCheckedChange={(checked) =>
                            form.setValue(
                              `rows.${index}.disabledResolutions`,
                              checked
                                ? row.disabledResolutions.filter(
                                    (withheld) => withheld !== tier
                                  )
                                : [...row.disabledResolutions, tier],
                              { shouldDirty: true }
                            )
                          }
                        />
                      </TableCell>
                    )
                  })}
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </SettingsForm>
    </SettingsSection>
  )
}
