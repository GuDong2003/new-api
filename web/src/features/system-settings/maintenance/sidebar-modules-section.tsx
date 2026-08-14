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
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Drag01Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { Reorder, useDragControls } from 'motion/react'
import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormLabel,
} from '@/components/ui/form'
import { Switch } from '@/components/ui/switch'

import {
  SettingsControlChildren,
  SettingsForm,
  SettingsSwitchContent,
  SettingsControlGroup,
  SettingsSwitchItem,
} from '../components/settings-form-layout'
import { SettingsPageFormActions } from '../components/settings-page-context'
import { SettingsSection } from '../components/settings-section'
import { useUpdateOption } from '../hooks/use-update-option'
import {
  SIDEBAR_MODULES_DEFAULT,
  getSidebarModuleOrder,
  type SidebarModulesAdminConfig,
  type SidebarSectionConfig,
  serializeSidebarModulesAdmin,
} from './config'

type SidebarModulesSectionProps = {
  config: SidebarModulesAdminConfig
  initialSerialized: string
}

type SidebarFormValues = SidebarModulesAdminConfig

const toTitleCase = (value: string) =>
  value
    .replaceAll(/[_-]+/g, ' ')
    .replaceAll(/\b\w/g, (char) => char.toUpperCase())

type SidebarModuleReorderItemProps = {
  value: string
  title: string
  index: number
  count: number
  onMove: (index: number, direction: 'up' | 'down') => void
  children: ReactNode
}

function SidebarModuleReorderItem({
  value,
  title,
  index,
  count,
  onMove,
  children,
}: SidebarModuleReorderItemProps) {
  const { t } = useTranslation()
  const dragControls = useDragControls()

  const handleDragStart = (event: PointerEvent<HTMLButtonElement>) => {
    dragControls.start(event)
  }

  const handleDragKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      onMove(index, 'up')
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      onMove(index, 'down')
    }
  }

  return (
    <Reorder.Item
      value={value}
      dragListener={false}
      dragControls={dragControls}
      className='bg-background flex min-w-0 items-center gap-2 rounded-lg border px-2'
    >
      <button
        type='button'
        className='text-muted-foreground hover:text-foreground flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-md active:cursor-grabbing'
        aria-label={t('Drag {{group}} to reorder', { group: title })}
        onPointerDown={handleDragStart}
        onKeyDown={handleDragKeyDown}
      >
        <HugeiconsIcon icon={Drag01Icon} strokeWidth={2} aria-hidden='true' />
      </button>
      <div className='min-w-0 flex-1'>{children}</div>
      <div className='flex shrink-0 gap-1'>
        <button
          type='button'
          className='text-muted-foreground hover:bg-muted hover:text-foreground flex size-7 items-center justify-center rounded-md disabled:pointer-events-none disabled:opacity-40'
          disabled={index === 0}
          aria-label={t('Move {{group}} up', { group: title })}
          onClick={() => onMove(index, 'up')}
        >
          <HugeiconsIcon
            icon={ArrowUp01Icon}
            strokeWidth={2}
            aria-hidden='true'
          />
        </button>
        <button
          type='button'
          className='text-muted-foreground hover:bg-muted hover:text-foreground flex size-7 items-center justify-center rounded-md disabled:pointer-events-none disabled:opacity-40'
          disabled={index === count - 1}
          aria-label={t('Move {{group}} down', { group: title })}
          onClick={() => onMove(index, 'down')}
        >
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            strokeWidth={2}
            aria-hidden='true'
          />
        </button>
      </div>
    </Reorder.Item>
  )
}

function buildModuleOrders(config: SidebarModulesAdminConfig) {
  return Object.entries(config).reduce<Record<string, string[]>>(
    (orders, [sectionKey, sectionConfig]) => {
      orders[sectionKey] = getSidebarModuleOrder(sectionConfig)
      return orders
    },
    {}
  )
}

function getSectionModuleOrder(
  sectionKey: string,
  sectionConfig: SidebarSectionConfig,
  order: string[] | undefined
) {
  return getSidebarModuleOrder(
    sectionConfig,
    order ?? SIDEBAR_MODULES_DEFAULT[sectionKey]?.order ?? []
  )
}

export function SidebarModulesSection({
  config,
  initialSerialized,
}: SidebarModulesSectionProps) {
  const { t } = useTranslation()
  const updateOption = useUpdateOption()

  const sectionMeta: Record<string, { title: string; description: string }> = {
    chat: {
      title: t('Chat area'),
      description: t('Playground experiments and live conversations.'),
    },
    console: {
      title: t('Console area'),
      description: t('Dashboards, tokens, and usage analytics.'),
    },
    personal: {
      title: t('Personal area'),
      description: t('Wallet management and personal preferences.'),
    },
    admin: {
      title: t('Admin area'),
      description: t('Global configuration and administrative tools.'),
    },
  }

  const moduleMeta: Record<
    string,
    Record<string, { title: string; description: string }>
  > = {
    chat: {
      playground: {
        title: t('Playground'),
        description: t('Experiment with prompts and models in real time.'),
      },
      chat: {
        title: t('Chat'),
        description: t('Access previous conversations and start new ones.'),
      },
    },
    console: {
      detail: {
        title: t('Dashboard'),
        description: t('Aggregated usage metrics and trend charts.'),
      },
      token: {
        title: t('Token management'),
        description: t('Create, revoke, and audit API tokens.'),
      },
      log: {
        title: t('Usage logs'),
        description: t('Detailed request logs for investigations.'),
      },
      midjourney: {
        title: t('Drawing logs'),
        description: t('History of MjProxy-style image tasks.'),
      },
      task: {
        title: t('Task logs'),
        description: t('Background job tracker for queued work.'),
      },
    },
    personal: {
      topup: {
        title: t('Wallet'),
        description: t('Top up balance and view billing history.'),
      },
      personal: {
        title: t('Profile'),
        description: t('Personal settings and profile management.'),
      },
    },
    admin: {
      channel: {
        title: t('Channels'),
        description: t('Configure upstream providers and routing.'),
      },
      models: {
        title: t('Models'),
        description: t('Manage catalog visibility and pricing.'),
      },
      queue: {
        title: t('Queue'),
        description: t('Queue channels'),
      },
      upstreamAccounts: {
        title: t('Automatic Check-in'),
        description: t('Manage upstream check-ins and real balances.'),
      },
      redemption: {
        title: t('Redeem codes'),
        description: t('Create and review invite or credit codes.'),
      },
      invitation: {
        title: t('Invitation Codes'),
        description: t('Invitation Code'),
      },
      user: {
        title: t('Users'),
        description: t('Administer user accounts and roles.'),
      },
      setting: {
        title: t('System settings'),
        description: t('Advanced platform configuration.'),
      },
      subscription: {
        title: t('Subscription Management'),
        description: t('Manage subscription plans and pricing.'),
      },
      systemInfo: {
        title: t('System Info'),
        description: t('System settings'),
      },
    },
  }
  const formDefaults = useMemo(() => config, [config])
  const [moduleOrders, setModuleOrders] = useState<Record<string, string[]>>(
    () => buildModuleOrders(formDefaults)
  )

  const form = useForm<SidebarFormValues>({
    defaultValues: formDefaults,
  })

  useEffect(() => {
    form.reset(formDefaults)
    setModuleOrders(buildModuleOrders(formDefaults))
  }, [formDefaults, form])

  const moveModule = (
    sectionKey: string,
    index: number,
    direction: 'up' | 'down'
  ) => {
    setModuleOrders((current) => {
      const order = [...(current[sectionKey] ?? [])]
      const targetIndex = direction === 'up' ? index - 1 : index + 1
      if (targetIndex < 0 || targetIndex >= order.length) return current

      const [moved] = order.splice(index, 1)
      order.splice(targetIndex, 0, moved)
      return { ...current, [sectionKey]: order }
    })
  }

  const onSubmit = async (values: SidebarFormValues) => {
    const valuesWithOrder = Object.entries(values).reduce<SidebarFormValues>(
      (nextValues, [sectionKey, sectionConfig]) => {
        nextValues[sectionKey] = {
          ...sectionConfig,
          order:
            moduleOrders[sectionKey] ?? getSidebarModuleOrder(sectionConfig),
        }
        return nextValues
      },
      {}
    )
    const serialized = serializeSidebarModulesAdmin(valuesWithOrder)
    if (serialized === initialSerialized) {
      return
    }

    await updateOption.mutateAsync({
      key: 'SidebarModulesAdmin',
      value: serialized,
    })
  }

  const resetToDefault = () => {
    form.reset(SIDEBAR_MODULES_DEFAULT)
    setModuleOrders(buildModuleOrders(SIDEBAR_MODULES_DEFAULT))
  }

  const sections = Object.entries(config)

  return (
    <SettingsSection title={t('Sidebar modules')}>
      <Form {...form}>
        <SettingsForm onSubmit={form.handleSubmit(onSubmit)}>
          <SettingsPageFormActions
            onSave={form.handleSubmit(onSubmit)}
            onReset={resetToDefault}
            isSaving={updateOption.isPending}
            resetLabel='Reset to default'
            saveLabel='Save sidebar modules'
          />
          {sections.map(([sectionKey, sectionConfig]) => {
            const sectionInfo = sectionMeta[sectionKey] ?? {
              title: toTitleCase(sectionKey),
              description: t('Custom sidebar section'),
            }
            const modules = getSectionModuleOrder(
              sectionKey,
              sectionConfig,
              moduleOrders[sectionKey]
            )

            return (
              <SettingsControlGroup key={sectionKey}>
                <FormField
                  control={form.control}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  name={`${sectionKey}.enabled` as any}
                  render={({ field }) => (
                    <SettingsSwitchItem>
                      <SettingsSwitchContent>
                        <FormLabel>{sectionInfo.title}</FormLabel>
                        <FormDescription>
                          {sectionInfo.description}
                        </FormDescription>
                      </SettingsSwitchContent>
                      <FormControl>
                        <Switch
                          checked={Boolean(field.value)}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                    </SettingsSwitchItem>
                  )}
                />

                <SettingsControlChildren>
                  <Reorder.Group
                    axis='y'
                    values={modules}
                    onReorder={(nextOrder) =>
                      setModuleOrders((current) => ({
                        ...current,
                        [sectionKey]: nextOrder,
                      }))
                    }
                    className='flex flex-col gap-2'
                  >
                    {modules.map((moduleKey, index) => {
                      const moduleInfo = moduleMeta[sectionKey]?.[
                        moduleKey
                      ] ?? {
                        title: toTitleCase(moduleKey),
                        description: t('Custom module'),
                      }
                      return (
                        <SidebarModuleReorderItem
                          key={`${sectionKey}.${moduleKey}`}
                          value={moduleKey}
                          title={moduleInfo.title}
                          index={index}
                          count={modules.length}
                          onMove={(itemIndex, direction) =>
                            moveModule(sectionKey, itemIndex, direction)
                          }
                        >
                          <FormField
                            control={form.control}
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            name={`${sectionKey}.${moduleKey}` as any}
                            render={({ field }) => (
                              <SettingsSwitchItem className='py-2'>
                                <SettingsSwitchContent>
                                  <FormLabel>{moduleInfo.title}</FormLabel>
                                  <FormDescription>
                                    {moduleInfo.description}
                                  </FormDescription>
                                </SettingsSwitchContent>
                                <FormControl>
                                  <Switch
                                    checked={Boolean(field.value)}
                                    onCheckedChange={field.onChange}
                                    disabled={
                                      !form.watch(
                                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                        `${sectionKey}.enabled` as any
                                      )
                                    }
                                  />
                                </FormControl>
                              </SettingsSwitchItem>
                            )}
                          />
                        </SidebarModuleReorderItem>
                      )
                    })}
                  </Reorder.Group>
                </SettingsControlChildren>
              </SettingsControlGroup>
            )
          })}
        </SettingsForm>
      </Form>
    </SettingsSection>
  )
}
