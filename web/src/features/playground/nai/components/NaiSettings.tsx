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
import { useQuery } from '@tanstack/react-query'
import { ArrowLeftRight, Dices, Sparkles } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useNaiDrawingStore } from '@/stores/nai-drawing-store'

import { getUserGroups, getUserModels } from '../../api'
import { validateNaiSettings } from '../lib/nai-settings'

const SAMPLERS = [
  'k_euler_ancestral',
  'k_euler',
  'k_dpmpp_2s_ancestral',
  'k_dpmpp_2m',
  'k_dpmpp_sde',
  'ddim_v3',
] as const

const NOISE_SCHEDULES = [
  'native',
  'karras',
  'exponential',
  'polyexponential',
] as const

export function NaiSettings(props: {
  userId: number
  onGenerate: () => void
  pendingCount: number
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const settings = useNaiDrawingStore((state) => state.settings)
  const updateSettings = useNaiDrawingStore((state) => state.updateSettings)
  const groups = useQuery({
    queryKey: ['nai-groups', props.userId],
    queryFn: getUserGroups,
  })
  const models = useQuery({
    queryKey: ['nai-models', props.userId, settings.group],
    queryFn: () => getUserModels(settings.group),
    enabled: Boolean(settings.group),
  })
  const naiModels = useMemo(() => models.data || [], [models.data])

  useEffect(() => {
    if (
      !groups.data?.length ||
      groups.data.some((group) => group.value === settings.group)
    ) {
      return
    }
    updateSettings({ group: groups.data[0].value, model: '' })
  }, [groups.data, settings.group, updateSettings])

  useEffect(() => {
    if (settings.model || !naiModels.length) return
    updateSettings({ model: naiModels[0].value })
  }, [naiModels, settings.model, updateSettings])

  const setNumber = (
    field: 'width' | 'height' | 'steps' | 'n',
    value: string
  ) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return
    updateSettings({ [field]: parsed } as Partial<typeof settings>)
  }

  const validation = validateNaiSettings(settings)

  return (
    <div className='flex h-full min-h-0 flex-col'>
      <div className='min-h-0 flex-1 space-y-5 overflow-y-auto p-4'>
        <div className='space-y-1'>
          <h2 className='flex items-center gap-2 text-sm font-semibold'>
            <Sparkles className='text-primary size-4' aria-hidden='true' />
            {t('NAI generation settings')}
          </h2>
          <p className='text-muted-foreground text-xs'>
            {t('NovelAI native image generation')}
          </p>
        </div>
        <div className='grid grid-cols-2 gap-3'>
          <div className='space-y-1.5'>
            <Label htmlFor='nai-group'>{t('Group')}</Label>
            <NativeSelect
              id='nai-group'
              className='w-full'
              value={settings.group}
              disabled={groups.isPending}
              onChange={(event) =>
                updateSettings({ group: event.target.value, model: '' })
              }
            >
              {groups.data?.map((group) => (
                <NativeSelectOption key={group.value} value={group.value}>
                  {group.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='nai-count'>{t('Image count')}</Label>
            <Input
              id='nai-count'
              type='number'
              min={1}
              max={8}
              value={settings.n}
              onChange={(event) => setNumber('n', event.target.value)}
            />
          </div>
        </div>
        <div className='space-y-1.5'>
          <Label htmlFor='nai-model'>{t('Model')}</Label>
          <Input
            id='nai-model'
            list='nai-models'
            value={settings.model}
            autoComplete='off'
            placeholder={t('Select a NovelAI model.')}
            onChange={(event) => updateSettings({ model: event.target.value })}
          />
          <datalist id='nai-models'>
            {naiModels.map((model) => (
              <option key={model.value} value={model.value} />
            ))}
          </datalist>
          {!models.isPending && !naiModels.length && (
            <p className='text-muted-foreground text-xs'>
              {t('No NovelAI models are available in this group.')}
            </p>
          )}
        </div>
        {(groups.isError || models.isError) && (
          <Alert variant='destructive'>
            <AlertDescription>
              {t('Could not load available models or groups.')}
            </AlertDescription>
          </Alert>
        )}
        <div className='space-y-1.5'>
          <Label htmlFor='nai-prompt'>{t('Positive prompt')}</Label>
          <Textarea
            id='nai-prompt'
            value={settings.prompt}
            maxLength={32000}
            className='min-h-32 resize-y text-sm leading-relaxed'
            placeholder={t(
              'Describe your image with NovelAI tags and natural language.'
            )}
            onChange={(event) => updateSettings({ prompt: event.target.value })}
          />
        </div>
        <div className='space-y-1.5'>
          <Label htmlFor='nai-negative-prompt'>{t('Negative prompt')}</Label>
          <Textarea
            id='nai-negative-prompt'
            value={settings.negativePrompt}
            maxLength={32000}
            className='min-h-20 resize-y text-sm leading-relaxed'
            placeholder={t('Optional negative prompt')}
            onChange={(event) =>
              updateSettings({ negativePrompt: event.target.value })
            }
          />
        </div>
        <Separator />
        <div className='space-y-3'>
          <h3 className='text-sm font-medium'>{t('Canvas size')}</h3>
          <div className='grid grid-cols-[1fr_auto_1fr] items-end gap-2'>
            <div className='space-y-1.5'>
              <Label htmlFor='nai-width'>{t('Width')}</Label>
              <Input
                id='nai-width'
                type='number'
                min={64}
                max={2048}
                step={64}
                value={settings.width}
                onChange={(event) => setNumber('width', event.target.value)}
              />
            </div>
            <Button
              type='button'
              variant='ghost'
              size='icon-sm'
              title={t('Swap width and height')}
              aria-label={t('Swap width and height')}
              onClick={() =>
                updateSettings({
                  width: settings.height,
                  height: settings.width,
                })
              }
            >
              <ArrowLeftRight className='size-4' aria-hidden='true' />
            </Button>
            <div className='space-y-1.5'>
              <Label htmlFor='nai-height'>{t('Height')}</Label>
              <Input
                id='nai-height'
                type='number'
                min={64}
                max={2048}
                step={64}
                value={settings.height}
                onChange={(event) => setNumber('height', event.target.value)}
              />
            </div>
          </div>
        </div>
        <div className='grid grid-cols-2 gap-3'>
          <div className='space-y-1.5'>
            <Label htmlFor='nai-sampler'>{t('Sampler')}</Label>
            <NativeSelect
              id='nai-sampler'
              className='w-full'
              value={settings.sampler}
              onChange={(event) =>
                updateSettings({
                  sampler: event.target.value as typeof settings.sampler,
                })
              }
            >
              {SAMPLERS.map((sampler) => (
                <NativeSelectOption key={sampler} value={sampler}>
                  {sampler}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='nai-noise'>{t('Noise schedule')}</Label>
            <NativeSelect
              id='nai-noise'
              className='w-full'
              value={settings.noiseSchedule}
              onChange={(event) =>
                updateSettings({
                  noiseSchedule: event.target
                    .value as typeof settings.noiseSchedule,
                })
              }
            >
              {NOISE_SCHEDULES.map((schedule) => (
                <NativeSelectOption key={schedule} value={schedule}>
                  {schedule}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='nai-steps'>{t('Steps')}</Label>
            <Input
              id='nai-steps'
              type='number'
              min={1}
              max={50}
              value={settings.steps}
              onChange={(event) => setNumber('steps', event.target.value)}
            />
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='nai-scale'>{t('Guidance strength')}</Label>
            <Input
              id='nai-scale'
              type='number'
              min={0}
              max={30}
              step={0.1}
              value={settings.scale}
              onChange={(event) =>
                updateSettings({ scale: Number(event.target.value) })
              }
            />
          </div>
        </div>
        <div className='space-y-1.5'>
          <Label htmlFor='nai-seed'>{t('Seed')}</Label>
          <div className='flex gap-2'>
            <Input
              id='nai-seed'
              type='number'
              min={0}
              max={4294967295}
              value={settings.seed ?? ''}
              placeholder={t('Random')}
              onChange={(event) =>
                updateSettings({
                  seed: event.target.value ? Number(event.target.value) : null,
                })
              }
            />
            <Button
              type='button'
              variant='outline'
              size='icon-sm'
              title={t('Random seed')}
              aria-label={t('Random seed')}
              onClick={() =>
                updateSettings({ seed: Math.floor(Math.random() * 4294967296) })
              }
            >
              <Dices className='size-4' aria-hidden='true' />
            </Button>
            <Button
              type='button'
              variant='ghost'
              size='sm'
              onClick={() => updateSettings({ seed: null })}
            >
              {t('Clear')}
            </Button>
          </div>
        </div>
        <details className='bg-muted/20 rounded-lg border'>
          <summary className='cursor-pointer px-3 py-2 text-sm font-medium'>
            {t('Advanced settings')}
          </summary>
          <div className='space-y-3 border-t p-3'>
            <SettingSwitch
              label={t('Quality tags')}
              checked={settings.qualityToggle}
              onChange={(checked) => updateSettings({ qualityToggle: checked })}
            />
            {settings.qualityToggle && (
              <div className='space-y-1.5'>
                <Label htmlFor='nai-quality'>{t('Quality tag preset')}</Label>
                <NativeSelect
                  id='nai-quality'
                  className='w-full'
                  value={settings.qualityTier}
                  onChange={(event) =>
                    updateSettings({
                      qualityTier: event.target
                        .value as typeof settings.qualityTier,
                    })
                  }
                >
                  <NativeSelectOption value='standard'>
                    {t('Standard')}
                  </NativeSelectOption>
                  <NativeSelectOption value='light'>
                    {t('Light')}
                  </NativeSelectOption>
                </NativeSelect>
              </div>
            )}
            <div className='space-y-1.5'>
              <Label htmlFor='nai-uc'>{t('Undesired content preset')}</Label>
              <NativeSelect
                id='nai-uc'
                className='w-full'
                value={settings.ucPreset}
                onChange={(event) =>
                  updateSettings({
                    ucPreset: event.target.value as typeof settings.ucPreset,
                  })
                }
              >
                <NativeSelectOption value='none'>
                  {t('None')}
                </NativeSelectOption>
                <NativeSelectOption value='heavy'>
                  {t('Heavy')}
                </NativeSelectOption>
                <NativeSelectOption value='light'>
                  {t('Light')}
                </NativeSelectOption>
                <NativeSelectOption value='humanFocus'>
                  {t('Human focus')}
                </NativeSelectOption>
              </NativeSelect>
            </div>
            <SettingSwitch
              label={t('SMEA')}
              checked={settings.smea}
              onChange={(checked) => updateSettings({ smea: checked })}
            />
            <SettingSwitch
              label={t('SMEA dynamic')}
              checked={settings.smeaDyn}
              onChange={(checked) => updateSettings({ smeaDyn: checked })}
            />
            <SettingSwitch
              label={t('Decrisp')}
              checked={settings.decrisp}
              onChange={(checked) => updateSettings({ decrisp: checked })}
            />
          </div>
        </details>
        {validation && (
          <p role='alert' className='text-destructive text-xs'>
            {t(validation)}
          </p>
        )}
      </div>
      <div className='bg-background shrink-0 space-y-2 border-t p-4'>
        <Button
          type='button'
          className='w-full'
          disabled={Boolean(validation) || groups.isPending || models.isPending}
          onClick={props.onGenerate}
        >
          <Sparkles className='size-4' aria-hidden='true' />
          {t('Generate NAI images')}
        </Button>
        {props.pendingCount > 0 && (
          <Button
            type='button'
            variant='outline'
            size='sm'
            className='w-full'
            onClick={props.onCancel}
          >
            {t('Stop generation')} · {props.pendingCount}
          </Button>
        )}
        <p className='text-muted-foreground text-center text-[10px] leading-relaxed'>
          {t('Uses the selected NovelAI channel and your account balance.')}
        </p>
      </div>
    </div>
  )
}

function SettingSwitch(props: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className='flex items-center justify-between gap-3 text-sm'>
      <span>{props.label}</span>
      <Switch checked={props.checked} onCheckedChange={props.onChange} />
    </label>
  )
}
