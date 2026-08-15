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
import type { ColumnDef } from '@tanstack/react-table'
import {
  Activity,
  CalendarCheck,
  ChevronDown,
  CircleDollarSign,
  Edit3,
  ExternalLink,
  HeartPulse,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { DataTablePage, useDataTable } from '@/components/data-table'
import { Dialog } from '@/components/dialog'
import { SectionPageLayout } from '@/components/layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { formatCurrencyFromUSD } from '@/lib/currency'

import {
  checkinUpstreamAccount,
  createUpstreamAccount,
  deleteUpstreamAccount,
  healthCheckUpstreamAccount,
  listUpstreamAccountLogs,
  listUpstreamAccounts,
  listUpstreamChannelOptions,
  listUpstreamSiteTypes,
  refreshUpstreamAccountBalance,
  replaceUpstreamAccountChannels,
  updateChannelBalanceSource,
  updateUpstreamAccount,
} from './api'
import type {
  BalanceSource,
  UpstreamAccount,
  UpstreamAccountInput,
  UpstreamAccountLog,
  UpstreamChannelOption,
  UpstreamSiteTypeOption,
  UpstreamStatus,
} from './types'

const EMPTY_FORM: UpstreamAccountInput = {
  name: '',
  base_url: '',
  site_type: 'new_api',
  notes: '',
  tags: [],
  external_checkin_url: '',
  redeem_url: '',
  open_redeem_with_checkin: true,
  auth_type: 'token',
  user_id: 0,
  credential: '',
  auto_checkin: true,
  auto_balance: true,
  balance_interval: 60,
  channel_ids: [],
}

function formatTime(value?: number) {
  return value ? new Date(value * 1000).toLocaleString() : '—'
}

function formatBalance(value: number, unit: string) {
  if (unit === 'USD') {
    return formatCurrencyFromUSD(value, {
      digitsLarge: 2,
      digitsSmall: 4,
      abbreviate: false,
    })
  }
  return `${value.toLocaleString()} ${unit || 'QUOTA'}`
}

function statusBadge(status: UpstreamStatus) {
  const labels: Record<UpstreamStatus, string> = {
    unknown: '未检查',
    healthy: '正常',
    failed: '失败',
    manual_required: '需要手动验证',
  }
  const variants = {
    unknown: 'outline',
    healthy: 'secondary',
    failed: 'destructive',
    manual_required: 'warning',
  } as const
  const variant = variants[status]
  return <Badge variant={variant}>{labels[status] || status}</Badge>
}

type AccountDialogProps = {
  open: boolean
  account: UpstreamAccount | null
  channels: UpstreamChannelOption[]
  siteTypes: UpstreamSiteTypeOption[]
  saving: boolean
  onOpenChange: (open: boolean) => void
  onSave: (input: UpstreamAccountInput) => void
}

function createAccountForm(
  account: UpstreamAccount | null
): UpstreamAccountInput {
  if (!account) return { ...EMPTY_FORM, channel_ids: [] }

  return {
    name: account.name,
    base_url: account.base_url,
    site_type: account.site_type,
    notes: account.notes ?? '',
    tags: account.tags ?? [],
    external_checkin_url: account.external_checkin_url ?? '',
    redeem_url: account.redeem_url ?? '',
    open_redeem_with_checkin: account.open_redeem_with_checkin,
    auth_type: account.auth_type,
    user_id: account.user_id,
    credential: '',
    auto_checkin: account.auto_checkin,
    auto_balance: account.auto_balance,
    balance_interval: account.balance_interval,
    channel_ids: account.channel_ids ?? [],
  }
}

function AccountDialog(props: AccountDialogProps) {
  const { t } = useTranslation()
  const [form, setForm] = useState<UpstreamAccountInput>(() =>
    createAccountForm(props.account)
  )

  useEffect(() => {
    if (props.open) setForm(createAccountForm(props.account))
  }, [props.open, props.account])

  const selected = new Set(form.channel_ids ?? [])
  const selectedSiteType = props.siteTypes.find(
    (option) => option.value === form.site_type
  )
  const supportsCheckin = selectedSiteType?.supports_checkin ?? true
  const supportsBalance = selectedSiteType?.supports_balance ?? true
  const toggleChannel = (channel: UpstreamChannelOption, checked: boolean) => {
    const next = new Set(form.channel_ids ?? [])
    if (checked) next.add(channel.id)
    else next.delete(channel.id)

    const nextForm = { ...form, channel_ids: [...next] }
    if (checked) {
      nextForm.name = channel.name
      nextForm.base_url = channel.base_url ?? ''
    }
    setForm(nextForm)
  }

  const canSave = Boolean(
    form.name.trim() &&
    form.base_url.trim() &&
    (props.account || form.credential?.trim())
  )

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={props.account ? '编辑上游站点账号' : '添加上游站点账号'}
      description='账号只会用于站点签到、真实余额和健康检查，不会创建新渠道。'
      contentHeight='min(68vh, 42rem)'
      footer={
        <>
          <Button
            variant='outline'
            onClick={() => props.onOpenChange(false)}
            disabled={props.saving}
          >
            取消
          </Button>
          <Button
            onClick={() => props.onSave(form)}
            disabled={!canSave || props.saving}
          >
            {props.saving && <Loader2 className='animate-spin' />}
            保存
          </Button>
        </>
      }
    >
      <div className='space-y-5'>
        <div className='grid gap-4 sm:grid-cols-2'>
          <div className='space-y-2'>
            <Label htmlFor='upstream-name'>名称</Label>
            <Input
              id='upstream-name'
              value={form.name}
              placeholder='例如 ZE 主账号'
              onChange={(event) =>
                setForm({ ...form, name: event.target.value })
              }
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='upstream-url'>站点地址</Label>
            <Input
              id='upstream-url'
              value={form.base_url}
              placeholder='https://example.com'
              onChange={(event) =>
                setForm({ ...form, base_url: event.target.value })
              }
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='upstream-site-type'>{t('Site type')}</Label>
            <select
              id='upstream-site-type'
              className='border-input bg-background h-9 w-full rounded-lg border px-3 text-sm'
              value={form.site_type}
              onChange={(event) => {
                const siteType = event.target.value
                const option = props.siteTypes.find(
                  (item) => item.value === siteType
                )
                const authType = option?.auth_types.includes(form.auth_type)
                  ? form.auth_type
                  : option?.auth_types[0] || 'token'
                setForm({
                  ...form,
                  site_type: siteType,
                  auth_type: authType,
                  auto_checkin: option?.supports_checkin
                    ? form.auto_checkin
                    : false,
                  auto_balance: option?.supports_balance
                    ? form.auto_balance
                    : false,
                })
              }}
            >
              {(props.siteTypes.length
                ? props.siteTypes
                : [
                    {
                      value: 'new_api',
                      label: 'New API',
                      auth_types: ['token', 'cookie'],
                      supports_checkin: true,
                      supports_balance: true,
                      external_only: false,
                    },
                  ]
              ).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className='space-y-2'>
            <Label htmlFor='upstream-auth'>认证方式</Label>
            <select
              id='upstream-auth'
              className='border-input bg-background h-9 w-full rounded-lg border px-3 text-sm'
              value={form.auth_type}
              onChange={(event) =>
                setForm({
                  ...form,
                  auth_type: event.target.value as 'token' | 'cookie',
                })
              }
            >
              {(selectedSiteType?.auth_types ?? ['token', 'cookie']).map(
                (authType) => (
                  <option key={authType} value={authType}>
                    {authType === 'cookie' ? '浏览器 Cookie' : '系统访问令牌'}
                  </option>
                )
              )}
            </select>
          </div>
          <div className='space-y-2'>
            <Label htmlFor='upstream-user-id'>上游用户 ID（可选）</Label>
            <Input
              id='upstream-user-id'
              type='number'
              min={0}
              value={form.user_id}
              onChange={(event) =>
                setForm({ ...form, user_id: Number(event.target.value) || 0 })
              }
            />
          </div>
        </div>
        <div className='space-y-2'>
          <Label htmlFor='upstream-credential'>
            {form.auth_type === 'cookie' ? 'Cookie' : '系统访问令牌'}
          </Label>
          <Input
            id='upstream-credential'
            type='password'
            autoComplete='new-password'
            value={form.credential}
            placeholder={props.account ? '留空则保持原凭据' : '请输入凭据'}
            onChange={(event) =>
              setForm({ ...form, credential: event.target.value })
            }
          />
          <p className='text-muted-foreground text-xs'>
            凭据会加密保存，接口和页面都不会返回明文。
          </p>
        </div>
        <div className='grid gap-4 sm:grid-cols-2'>
          <div className='space-y-2'>
            <Label htmlFor='upstream-notes'>{t('Notes')}</Label>
            <Textarea
              id='upstream-notes'
              value={form.notes}
              placeholder={t('Add account purpose, plan, or other notes')}
              rows={2}
              onChange={(event) =>
                setForm({ ...form, notes: event.target.value })
              }
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='upstream-tags'>{t('Tags')}</Label>
            <Input
              id='upstream-tags'
              value={form.tags.join(', ')}
              placeholder='例如 svip, 自用, ZE'
              onChange={(event) =>
                setForm({
                  ...form,
                  tags: event.target.value
                    .split(',')
                    .map((tag) => tag.trim())
                    .filter(Boolean),
                })
              }
            />
            <p className='text-muted-foreground text-xs'>
              {t('Separate multiple tags with commas.')}
            </p>
          </div>
        </div>
        <div className='grid gap-4 sm:grid-cols-2'>
          <div className='space-y-2'>
            <Label htmlFor='upstream-external-checkin'>
              {t('External check-in URL')}
            </Label>
            <Input
              id='upstream-external-checkin'
              type='url'
              value={form.external_checkin_url}
              placeholder='https://example.com/checkin'
              onChange={(event) =>
                setForm({ ...form, external_checkin_url: event.target.value })
              }
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='upstream-redeem'>
              {t('Recharge / redeem URL')}
            </Label>
            <Input
              id='upstream-redeem'
              type='url'
              value={form.redeem_url}
              placeholder='https://example.com/redeem'
              onChange={(event) =>
                setForm({ ...form, redeem_url: event.target.value })
              }
            />
          </div>
        </div>
        {form.redeem_url && form.external_checkin_url && (
          <Label className='justify-between gap-3 rounded-lg border p-3'>
            <span>{t('Open recharge / redeem page after check-in')}</span>
            <Switch
              checked={form.open_redeem_with_checkin}
              onCheckedChange={(checked) =>
                setForm({ ...form, open_redeem_with_checkin: checked })
              }
            />
          </Label>
        )}
        {selectedSiteType && (
          <p className='text-muted-foreground rounded-lg border border-dashed p-3 text-xs'>
            {selectedSiteType.external_only
              ? t('This site type only provides external management links.')
              : t('Capabilities: {{checkin}}, {{balance}}', {
                  checkin: selectedSiteType.supports_checkin
                    ? t('Built-in check-in')
                    : t('External check-in'),
                  balance: selectedSiteType.supports_balance
                    ? t('Real balance query')
                    : t('Manual balance'),
                })}
          </p>
        )}
        <div className='grid gap-3 rounded-lg border p-3 sm:grid-cols-2'>
          <Label className='justify-between gap-3'>
            <span>自动签到</span>
            <Switch
              checked={form.auto_checkin}
              disabled={!supportsCheckin}
              onCheckedChange={(checked) =>
                setForm({ ...form, auto_checkin: checked })
              }
            />
          </Label>
          <Label className='justify-between gap-3'>
            <span>自动刷新真实余额</span>
            <Switch
              checked={form.auto_balance}
              disabled={!supportsBalance}
              onCheckedChange={(checked) =>
                setForm({ ...form, auto_balance: checked })
              }
            />
          </Label>
          <div className='space-y-2 sm:col-span-2'>
            <Label htmlFor='upstream-interval'>余额刷新间隔（分钟）</Label>
            <Input
              id='upstream-interval'
              type='number'
              min={5}
              value={form.balance_interval}
              onChange={(event) =>
                setForm({
                  ...form,
                  balance_interval: Math.max(
                    5,
                    Number(event.target.value) || 60
                  ),
                })
              }
            />
            {!supportsBalance && (
              <p className='text-muted-foreground text-xs'>
                {t(
                  'Current site type does not support built-in balance queries.'
                )}
              </p>
            )}
          </div>
        </div>
        <div className='space-y-2'>
          <Label>绑定现有渠道</Label>
          <div className='max-h-52 space-y-1 overflow-y-auto rounded-lg border p-2'>
            {props.channels.length === 0 ? (
              <p className='text-muted-foreground p-2 text-sm'>暂无现有渠道</p>
            ) : (
              props.channels.map((channel) => {
                const boundNames = channel.upstream_account_names?.length
                  ? channel.upstream_account_names.join('、')
                  : channel.upstream_account_name
                const boundCount =
                  channel.upstream_account_count ??
                  channel.upstream_account_ids?.length ??
                  (channel.upstream_account_id ? 1 : 0)
                return (
                  <Label
                    key={channel.id}
                    className='hover:bg-muted/50 justify-between rounded-md px-2 py-2'
                  >
                    <span className='min-w-0 truncate'>
                      #{channel.id} · {channel.name}
                      {boundCount > 0 && (
                        <span className='text-muted-foreground ml-2 text-xs'>
                          已绑定 {boundCount} 个账号
                          {boundNames ? `：${boundNames}` : ''}
                        </span>
                      )}
                    </span>
                    <Checkbox
                      checked={selected.has(channel.id)}
                      onCheckedChange={(checked) =>
                        toggleChannel(channel, checked === true)
                      }
                    />
                  </Label>
                )
              })
            )}
          </div>
          <p className='text-muted-foreground text-xs'>
            一个渠道可以绑定多个站点账号，渠道余额会合并这些账号的余额；取消勾选只会解除当前账号的绑定。
          </p>
        </div>
      </div>
    </Dialog>
  )
}

const LOG_TYPE_LABELS: Record<UpstreamAccountLog['type'], string> = {
  checkin: '签到',
  balance: '余额',
  health: '健康检查',
}

const LOG_TRIGGER_LABELS: Record<UpstreamAccountLog['trigger'], string> = {
  manual: '手动',
  scheduled: '定时',
  retry: '自动重试',
}

const CHECKIN_MAX_ATTEMPTS_PER_DAY = 4

const LOG_STATUS_OPTIONS = [
  { label: '正常', value: 'healthy' },
  { label: '失败', value: 'failed' },
  { label: '需要手动验证', value: 'manual_required' },
] as const

const ACCOUNT_STATUS_OPTIONS: Array<{ label: string; value: UpstreamStatus }> =
  [
    { label: '正常', value: 'healthy' },
    { label: '失败', value: 'failed' },
    { label: '需要手动验证', value: 'manual_required' },
    { label: '未检查', value: 'unknown' },
  ]

function UpstreamLogsTable(props: {
  logs: UpstreamAccountLog[]
  accountNames: Map<number, string>
  isLoading: boolean
}) {
  const columns = useMemo<ColumnDef<UpstreamAccountLog, unknown>[]>(
    () => [
      {
        accessorKey: 'created_at',
        header: '时间',
        cell: ({ row }) => (
          <span className='whitespace-nowrap'>
            {formatTime(row.original.created_at)}
          </span>
        ),
      },
      {
        id: 'account',
        accessorFn: (row) => props.accountNames.get(row.account_id) ?? '',
        header: '站点账号',
        cell: ({ row }) =>
          props.accountNames.get(row.original.account_id) ||
          `#${row.original.account_id}`,
      },
      {
        accessorKey: 'type',
        header: '操作',
        cell: ({ row }) => LOG_TYPE_LABELS[row.original.type],
      },
      {
        accessorKey: 'trigger',
        header: '触发',
        cell: ({ row }) => LOG_TRIGGER_LABELS[row.original.trigger],
      },
      {
        accessorKey: 'status',
        header: '状态',
        cell: ({ row }) => statusBadge(row.original.status),
      },
      {
        accessorKey: 'message',
        header: '结果',
        cell: ({ row }) => {
          const log = row.original
          const result =
            log.type === 'balance' && log.status === 'healthy'
              ? formatBalance(log.balance, log.unit)
              : log.message || '—'
          return (
            <span className='block max-w-80 truncate' title={result}>
              {result}
            </span>
          )
        },
      },
      {
        accessorKey: 'duration_ms',
        header: () => <span className='block text-right'>耗时</span>,
        cell: ({ row }) => (
          <span className='block text-right whitespace-nowrap'>
            {row.original.duration_ms} ms
          </span>
        ),
      },
    ],
    [props.accountNames]
  )

  const { table } = useDataTable({
    data: props.logs,
    columns,
    getRowId: (row) => String(row.id),
    globalFilterFn: (row, _columnId, filterValue) => {
      const log = row.original
      const searchValue = String(filterValue).trim().toLowerCase()
      if (!searchValue) return true
      return [
        props.accountNames.get(log.account_id),
        log.message,
        LOG_TYPE_LABELS[log.type],
        LOG_TRIGGER_LABELS[log.trigger],
        log.status,
      ]
        .join(' ')
        .toLowerCase()
        .includes(searchValue)
    },
  })

  return (
    <DataTablePage
      table={table}
      columns={columns}
      isLoading={props.isLoading}
      emptyTitle='暂无执行日志'
      emptyDescription='签到、余额和健康检查的执行记录会显示在这里。'
      skeletonKeyPrefix='upstream-log-skeleton'
      fixedHeight={false}
      paginationInFooter={false}
      tableClassName='rounded-none border-x-0 border-b-0'
      toolbarProps={{
        searchPlaceholder: '搜索站点、操作或结果…',
        searchDebounceMs: 300,
        hideViewOptions: true,
        filters: [
          {
            columnId: 'type',
            title: '操作',
            options: Object.entries(LOG_TYPE_LABELS).map(([value, label]) => ({
              value,
              label,
            })),
            singleSelect: true,
          },
          {
            columnId: 'trigger',
            title: '触发',
            options: Object.entries(LOG_TRIGGER_LABELS).map(
              ([value, label]) => ({ value, label })
            ),
            singleSelect: true,
          },
          {
            columnId: 'status',
            title: '状态',
            options: LOG_STATUS_OPTIONS.map(({ value, label }) => ({
              value,
              label,
            })),
            singleSelect: true,
          },
        ],
      }}
    />
  )
}

export function UpstreamAccountsPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<UpstreamAccount | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<UpstreamAccount | null>(null)
  const [runningKey, setRunningKey] = useState('')
  const [accountSearch, setAccountSearch] = useState('')
  const [accountStatusFilter, setAccountStatusFilter] = useState<
    UpstreamStatus | 'all'
  >('all')
  const [accountCheckinFilter, setAccountCheckinFilter] = useState<
    'all' | 'enabled' | 'disabled'
  >('all')
  const [accountSiteTypeFilter, setAccountSiteTypeFilter] = useState('all')
  const [accountTagFilter, setAccountTagFilter] = useState('all')
  const [balanceSourceOpen, setBalanceSourceOpen] = useState(false)

  const accountsQuery = useQuery({
    queryKey: ['upstream-accounts'],
    queryFn: listUpstreamAccounts,
  })
  const channelsQuery = useQuery({
    queryKey: ['upstream-account-channels'],
    queryFn: listUpstreamChannelOptions,
  })
  const logsQuery = useQuery({
    queryKey: ['upstream-account-logs'],
    queryFn: () => listUpstreamAccountLogs(100),
  })
  const siteTypesQuery = useQuery({
    queryKey: ['upstream-account-site-types'],
    queryFn: listUpstreamSiteTypes,
    staleTime: 30 * 60 * 1000,
  })

  const refreshAll = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['upstream-accounts'] }),
      queryClient.invalidateQueries({
        queryKey: ['upstream-account-channels'],
      }),
      queryClient.invalidateQueries({ queryKey: ['upstream-account-logs'] }),
      queryClient.invalidateQueries({ queryKey: ['channels'] }),
    ])
  }

  const saveMutation = useMutation({
    mutationFn: async (input: UpstreamAccountInput) => {
      if (editing) {
        await updateUpstreamAccount(editing.id, input)
        await replaceUpstreamAccountChannels(
          editing.id,
          input.channel_ids ?? []
        )
      } else {
        await createUpstreamAccount(input)
      }
    },
    onSuccess: async () => {
      toast.success(editing ? '上游站点账号已更新' : '上游站点账号已添加')
      setDialogOpen(false)
      setEditing(null)
      await refreshAll()
    },
    onError: (error) => toast.error(error.message),
  })

  const deleteMutation = useMutation({
    mutationFn: deleteUpstreamAccount,
    onSuccess: async () => {
      toast.success('上游站点账号已删除')
      setDeleteTarget(null)
      await refreshAll()
    },
    onError: (error) => toast.error(error.message),
  })

  const sourceMutation = useMutation({
    mutationFn: ({ id, source }: { id: number; source: BalanceSource }) =>
      updateChannelBalanceSource(id, source),
    onSuccess: async () => {
      toast.success('渠道余额来源已更新')
      await refreshAll()
    },
    onError: (error) => toast.error(error.message),
  })

  const run = async (
    account: UpstreamAccount,
    type: 'checkin' | 'balance' | 'health'
  ) => {
    const key = `${account.id}:${type}`
    setRunningKey(key)
    try {
      if (type === 'checkin') await checkinUpstreamAccount(account.id)
      if (type === 'balance') await refreshUpstreamAccountBalance(account.id)
      if (type === 'health') await healthCheckUpstreamAccount(account.id)
      const operationLabels = {
        checkin: '签到完成',
        balance: '真实余额已刷新',
        health: '健康检查完成',
      }
      toast.success(operationLabels[type])
      await refreshAll()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '操作失败')
      await refreshAll()
    } finally {
      setRunningKey('')
    }
  }

  const accountNames = useMemo(
    () =>
      new Map(
        (accountsQuery.data ?? []).map((account) => [account.id, account.name])
      ),
    [accountsQuery.data]
  )

  const filteredAccounts = useMemo(() => {
    const search = accountSearch.trim().toLowerCase()
    return (accountsQuery.data ?? []).filter((account) => {
      const matchesSearch =
        !search ||
        account.name.toLowerCase().includes(search) ||
        account.base_url.toLowerCase().includes(search) ||
        (account.notes ?? '').toLowerCase().includes(search) ||
        (account.tags ?? []).some((tag) => tag.toLowerCase().includes(search))
      const matchesStatus =
        accountStatusFilter === 'all' ||
        [
          account.last_checkin_status,
          account.balance_status,
          account.health_status,
        ].includes(accountStatusFilter)
      const matchesCheckin =
        accountCheckinFilter === 'all' ||
        (accountCheckinFilter === 'enabled'
          ? account.auto_checkin
          : !account.auto_checkin)
      const matchesSiteType =
        accountSiteTypeFilter === 'all' ||
        account.site_type === accountSiteTypeFilter
      const matchesTag =
        accountTagFilter === 'all' ||
        (account.tags ?? []).includes(accountTagFilter)
      return (
        matchesSearch &&
        matchesStatus &&
        matchesCheckin &&
        matchesSiteType &&
        matchesTag
      )
    })
  }, [
    accountSearch,
    accountCheckinFilter,
    accountStatusFilter,
    accountSiteTypeFilter,
    accountTagFilter,
    accountsQuery.data,
  ])

  const siteTypeMap = useMemo(
    () =>
      new Map(
        (siteTypesQuery.data ?? []).map((option) => [option.value, option])
      ),
    [siteTypesQuery.data]
  )
  const availableTags = useMemo(
    () =>
      [
        ...new Set(
          (accountsQuery.data ?? []).flatMap((account) => account.tags ?? [])
        ),
      ].sort(),
    [accountsQuery.data]
  )
  const openExternal = (url: string) => {
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
  }
  const openAllExternalCheckins = () => {
    filteredAccounts
      .filter((account) => account.external_checkin_url)
      .forEach((account) => openExternal(account.external_checkin_url))
  }

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>
        <span className='flex items-center gap-2'>
          <CalendarCheck className='size-4 text-emerald-500' />
          自动签到
        </span>
      </SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <Button variant='outline' size='sm' onClick={() => void refreshAll()}>
          <RefreshCw /> 刷新
        </Button>
        <Button
          size='sm'
          onClick={() => {
            setEditing(null)
            setDialogOpen(true)
          }}
        >
          <Plus /> 添加站点账号
        </Button>
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        <div className='space-y-4'>
          <div className='flex flex-wrap items-center gap-2'>
            <div className='relative min-w-56 flex-1'>
              <Search className='text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2' />
              <Input
                className='h-8 pl-8 text-sm'
                placeholder='搜索站点名称或地址…'
                value={accountSearch}
                onChange={(event) => setAccountSearch(event.target.value)}
              />
            </div>
            <select
              className='border-input bg-background h-8 rounded-lg border px-2 text-sm'
              value={accountStatusFilter}
              onChange={(event) =>
                setAccountStatusFilter(
                  event.target.value as UpstreamStatus | 'all'
                )
              }
            >
              <option value='all'>全部状态</option>
              {ACCOUNT_STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              className='border-input bg-background h-8 rounded-lg border px-2 text-sm'
              value={accountCheckinFilter}
              onChange={(event) =>
                setAccountCheckinFilter(
                  event.target.value as 'all' | 'enabled' | 'disabled'
                )
              }
            >
              <option value='all'>全部签到设置</option>
              <option value='enabled'>自动签到已开启</option>
              <option value='disabled'>自动签到已关闭</option>
            </select>
            <select
              className='border-input bg-background h-8 rounded-lg border px-2 text-sm'
              value={accountSiteTypeFilter}
              onChange={(event) => setAccountSiteTypeFilter(event.target.value)}
            >
              <option value='all'>{t('All site types')}</option>
              {(siteTypesQuery.data ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {availableTags.length > 0 && (
              <select
                className='border-input bg-background h-8 rounded-lg border px-2 text-sm'
                value={accountTagFilter}
                onChange={(event) => setAccountTagFilter(event.target.value)}
              >
                <option value='all'>{t('All tags')}</option>
                {availableTags.map((tag) => (
                  <option key={tag} value={tag}>
                    {tag}
                  </option>
                ))}
              </select>
            )}
            <Button
              variant='outline'
              size='sm'
              onClick={openAllExternalCheckins}
              disabled={
                !filteredAccounts.some(
                  (account) => account.external_checkin_url
                )
              }
            >
              <ExternalLink /> {t('Open external check-ins')}
            </Button>
            <Button
              variant='ghost'
              size='sm'
              onClick={() => {
                setAccountSearch('')
                setAccountStatusFilter('all')
                setAccountCheckinFilter('all')
                setAccountSiteTypeFilter('all')
                setAccountTagFilter('all')
              }}
              disabled={
                !accountSearch &&
                accountStatusFilter === 'all' &&
                accountCheckinFilter === 'all' &&
                accountSiteTypeFilter === 'all' &&
                accountTagFilter === 'all'
              }
            >
              重置
            </Button>
            <span className='text-muted-foreground text-xs'>
              {filteredAccounts.length}/{accountsQuery.data?.length ?? 0} 个账号
            </span>
          </div>
          {(() => {
            if (accountsQuery.isLoading) {
              return (
                <div className='grid gap-4 lg:grid-cols-2'>
                  <Skeleton className='h-64' />
                  <Skeleton className='h-64' />
                </div>
              )
            }
            if (accountsQuery.data?.length) {
              if (!filteredAccounts.length) {
                return (
                  <Card>
                    <CardContent className='text-muted-foreground flex min-h-32 items-center justify-center text-sm'>
                      没有匹配的站点账号
                    </CardContent>
                  </Card>
                )
              }
              return (
                <div className='grid gap-4 lg:grid-cols-2'>
                  {filteredAccounts.map((account) => (
                    <Card key={account.id}>
                      <CardHeader className='pb-3'>
                        <div className='flex items-start justify-between gap-3'>
                          <div className='min-w-0'>
                            <div className='flex flex-wrap items-center gap-2'>
                              <CardTitle className='truncate text-base'>
                                {account.name}
                              </CardTitle>
                              <Badge variant='outline'>
                                {siteTypeMap.get(account.site_type)?.label ||
                                  account.site_type}
                              </Badge>
                              {siteTypeMap.get(account.site_type)
                                ?.external_only && (
                                <Badge variant='warning'>
                                  {t('External management')}
                                </Badge>
                              )}
                            </div>
                            <a
                              className='text-muted-foreground hover:text-foreground text-xs'
                              href={account.base_url}
                              target='_blank'
                              rel='noreferrer'
                            >
                              {account.base_url}
                            </a>
                            {(account.notes ||
                              (account.tags ?? []).length > 0) && (
                              <div className='mt-1 flex flex-wrap items-center gap-1 text-xs'>
                                {account.notes && (
                                  <span
                                    className='text-muted-foreground truncate'
                                    title={account.notes}
                                  >
                                    {account.notes}
                                  </span>
                                )}
                                {(account.tags ?? []).map((tag) => (
                                  <Badge
                                    key={tag}
                                    variant='secondary'
                                    className='text-[11px]'
                                  >
                                    {tag}
                                  </Badge>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className='flex items-center gap-1'>
                            <Button
                              variant='outline'
                              size='sm'
                              render={
                                <a
                                  href={account.base_url}
                                  target='_blank'
                                  rel='noreferrer'
                                />
                              }
                            >
                              <ExternalLink />
                              前往站点
                            </Button>
                            <Button
                              variant='ghost'
                              size='icon-sm'
                              onClick={() => {
                                setEditing(account)
                                setDialogOpen(true)
                              }}
                              aria-label='编辑'
                            >
                              <Edit3 />
                            </Button>
                            <Button
                              variant='ghost'
                              size='icon-sm'
                              onClick={() => {
                                setDeleteTarget(account)
                              }}
                              aria-label='删除'
                            >
                              <Trash2 className='text-destructive' />
                            </Button>
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className='space-y-4'>
                        <div className='grid grid-cols-2 gap-3 text-sm'>
                          <div className='rounded-lg border p-3'>
                            <div className='text-muted-foreground mb-1 text-xs'>
                              真实余额
                            </div>
                            <div className='font-semibold'>
                              {account.balance_updated_time
                                ? formatBalance(
                                    account.balance,
                                    account.balance_unit
                                  )
                                : '—'}
                            </div>
                            <div className='mt-1'>
                              {statusBadge(account.balance_status)}
                            </div>
                          </div>
                          <div className='rounded-lg border p-3'>
                            <div className='text-muted-foreground mb-1 text-xs'>
                              最近签到
                            </div>
                            <div className='truncate font-medium'>
                              {formatTime(account.last_checkin_time)}
                            </div>
                            <div className='mt-1'>
                              {statusBadge(account.last_checkin_status)}
                            </div>
                          </div>
                        </div>
                        <div className='text-muted-foreground space-y-1 text-xs'>
                          <p>
                            自动签到：{account.auto_checkin ? '开启' : '关闭'} ·
                            自动余额：
                            {account.auto_balance ? '开启' : '关闭'}
                          </p>
                          {account.auto_checkin && (
                            <p>
                              失败重试：约每 6 小时一次（随机延迟 0～30 分钟），
                              今日 {account.checkin_attempts || 0}/
                              {CHECKIN_MAX_ATTEMPTS_PER_DAY} 次
                              {account.checkin_attempt_date
                                ? `（${account.checkin_attempt_date}）`
                                : ''}{' '}
                              · 下次：
                              {formatTime(account.next_checkin_time)}
                            </p>
                          )}
                          <p>
                            绑定渠道：
                            {(account.channel_ids ?? []).length
                              ? (account.channel_ids ?? [])
                                  .map((id) =>
                                    channelsQuery.data?.find(
                                      (item) => item.id === id
                                    )
                                  )
                                  .filter(Boolean)
                                  .map((item) => `#${item?.id} ${item?.name}`)
                                  .join('、')
                              : '无'}
                          </p>
                          {account.last_error && (
                            <p className='text-destructive line-clamp-2'>
                              {account.last_error}
                            </p>
                          )}
                        </div>
                        <div className='grid grid-cols-3 gap-2'>
                          <Button
                            variant='outline'
                            size='sm'
                            onClick={() => void run(account, 'checkin')}
                            disabled={
                              runningKey !== '' ||
                              siteTypeMap.get(account.site_type)
                                ?.supports_checkin === false
                            }
                          >
                            {runningKey === `${account.id}:checkin` ? (
                              <Loader2 className='animate-spin' />
                            ) : (
                              <CalendarCheck />
                            )}
                            签到
                          </Button>
                          <Button
                            variant='outline'
                            size='sm'
                            onClick={() => void run(account, 'balance')}
                            disabled={
                              runningKey !== '' ||
                              siteTypeMap.get(account.site_type)
                                ?.supports_balance === false
                            }
                          >
                            {runningKey === `${account.id}:balance` ? (
                              <Loader2 className='animate-spin' />
                            ) : (
                              <CircleDollarSign />
                            )}
                            余额
                          </Button>
                          <Button
                            variant='outline'
                            size='sm'
                            onClick={() => void run(account, 'health')}
                            disabled={
                              runningKey !== '' ||
                              siteTypeMap.get(account.site_type)?.external_only
                            }
                          >
                            {runningKey === `${account.id}:health` ? (
                              <Loader2 className='animate-spin' />
                            ) : (
                              <HeartPulse />
                            )}
                            检查
                          </Button>
                        </div>
                        {(account.external_checkin_url ||
                          account.redeem_url) && (
                          <div className='grid grid-cols-2 gap-2'>
                            {account.external_checkin_url && (
                              <Button
                                variant='ghost'
                                size='sm'
                                onClick={() => {
                                  openExternal(account.external_checkin_url)
                                  if (
                                    account.open_redeem_with_checkin &&
                                    account.redeem_url
                                  ) {
                                    openExternal(account.redeem_url)
                                  }
                                }}
                              >
                                <ExternalLink /> {t('External check-in')}
                              </Button>
                            )}
                            {account.redeem_url && (
                              <Button
                                variant='ghost'
                                size='sm'
                                onClick={() => openExternal(account.redeem_url)}
                              >
                                <ExternalLink /> {t('Recharge / redeem')}
                              </Button>
                            )}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )
            }
            return (
              <Card>
                <CardContent className='text-muted-foreground flex min-h-40 flex-col items-center justify-center gap-2 text-sm'>
                  <CalendarCheck className='size-8 opacity-50' />
                  还没有添加上游站点账号
                </CardContent>
              </Card>
            )
          })()}

          <Card>
            <Collapsible
              open={balanceSourceOpen}
              onOpenChange={setBalanceSourceOpen}
            >
              <CardHeader className='py-3'>
                <CollapsibleTrigger
                  render={
                    <Button
                      type='button'
                      variant='ghost'
                      className='h-auto w-full justify-between px-0'
                    />
                  }
                >
                  <CardTitle className='flex items-center gap-2 text-sm'>
                    <CircleDollarSign className='size-4' />
                    渠道余额来源
                    <span className='text-muted-foreground text-xs font-normal'>
                      {channelsQuery.data?.length ?? 0} 个渠道
                    </span>
                  </CardTitle>
                  <ChevronDown
                    className={`text-muted-foreground size-4 transition-transform ${
                      balanceSourceOpen ? 'rotate-180' : ''
                    }`}
                  />
                </CollapsibleTrigger>
              </CardHeader>
              <CollapsibleContent>
                <CardContent className='px-3 pt-0 pb-3'>
                  <div className='max-h-72 overflow-auto rounded-lg border'>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>渠道</TableHead>
                          <TableHead>绑定账号</TableHead>
                          <TableHead>余额来源</TableHead>
                          <TableHead>上游真实余额</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(channelsQuery.data ?? []).map((channel) => (
                          <TableRow key={channel.id}>
                            <TableCell className='font-medium'>
                              #{channel.id} · {channel.name}
                            </TableCell>
                            <TableCell>
                              {channel.upstream_account_names?.length
                                ? channel.upstream_account_names.join('、')
                                : channel.upstream_account_name || '—'}
                            </TableCell>
                            <TableCell>
                              <select
                                className='border-input bg-background h-8 rounded-lg border px-2 text-sm'
                                value={channel.balance_source || 'channel'}
                                disabled={sourceMutation.isPending}
                                onChange={(event) =>
                                  sourceMutation.mutate({
                                    id: channel.id,
                                    source: event.target.value as BalanceSource,
                                  })
                                }
                              >
                                <option value='channel'>现有渠道接口</option>
                                <option
                                  value='upstream'
                                  disabled={
                                    !(
                                      (channel.upstream_account_count ??
                                        channel.upstream_account_ids?.length ??
                                        0) > 0 || channel.upstream_account_id
                                    )
                                  }
                                >
                                  绑定的站点账号
                                </option>
                                <option value='none'>不查询</option>
                              </select>
                            </TableCell>
                            <TableCell>
                              {channel.upstream_balance == null
                                ? '—'
                                : formatBalance(
                                    channel.upstream_balance,
                                    channel.upstream_balance_unit || 'QUOTA'
                                  )}
                            </TableCell>
                          </TableRow>
                        ))}
                        {!channelsQuery.isLoading &&
                          (channelsQuery.data ?? []).length === 0 && (
                            <TableRow>
                              <TableCell colSpan={4} className='text-center'>
                                暂无渠道
                              </TableCell>
                            </TableRow>
                          )}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </CollapsibleContent>
            </Collapsible>
          </Card>

          <Card>
            <CardHeader className='pb-3'>
              <CardTitle className='flex items-center gap-2 text-sm'>
                <Activity className='size-4' />
                执行日志
              </CardTitle>
            </CardHeader>
            <CardContent className='p-0'>
              <UpstreamLogsTable
                logs={logsQuery.data ?? []}
                accountNames={accountNames}
                isLoading={logsQuery.isLoading}
              />
            </CardContent>
          </Card>
        </div>
        <AccountDialog
          open={dialogOpen}
          account={editing}
          channels={channelsQuery.data ?? []}
          siteTypes={siteTypesQuery.data ?? []}
          saving={saveMutation.isPending}
          onOpenChange={(open) => {
            setDialogOpen(open)
            if (!open) setEditing(null)
          }}
          onSave={(input) => saveMutation.mutate(input)}
        />
        <ConfirmDialog
          open={deleteTarget !== null}
          onOpenChange={(open) => {
            if (!open && !deleteMutation.isPending) setDeleteTarget(null)
          }}
          title='删除上游站点账号'
          desc={
            deleteTarget
              ? `确定删除“${deleteTarget.name}”及其执行日志吗？绑定渠道会恢复使用原渠道接口。`
              : ''
          }
          confirmText='删除'
          destructive
          isLoading={deleteMutation.isPending}
          disabled={!deleteTarget}
          handleConfirm={() => {
            if (deleteTarget) deleteMutation.mutate(deleteTarget.id)
          }}
        />
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
