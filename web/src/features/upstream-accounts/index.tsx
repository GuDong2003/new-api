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
import {
  Activity,
  CalendarCheck,
  CircleDollarSign,
  Edit3,
  HeartPulse,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { Dialog } from '@/components/dialog'
import { SectionPageLayout } from '@/components/layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
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
import { formatCurrencyFromUSD } from '@/lib/currency'

import {
  checkinUpstreamAccount,
  createUpstreamAccount,
  deleteUpstreamAccount,
  healthCheckUpstreamAccount,
  listUpstreamAccountLogs,
  listUpstreamAccounts,
  listUpstreamChannelOptions,
  refreshUpstreamAccountBalance,
  replaceUpstreamAccountChannels,
  updateChannelBalanceSource,
  updateUpstreamAccount,
} from './api'
import type {
  BalanceSource,
  UpstreamAccount,
  UpstreamAccountInput,
  UpstreamChannelOption,
  UpstreamStatus,
} from './types'

const EMPTY_FORM: UpstreamAccountInput = {
  name: '',
  base_url: '',
  site_type: 'new_api',
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
    site_type: 'new_api',
    auth_type: account.auth_type,
    user_id: account.user_id,
    credential: '',
    auto_checkin: account.auto_checkin,
    auto_balance: account.auto_balance,
    balance_interval: account.balance_interval,
    channel_ids: account.channel_ids,
  }
}

function AccountDialog(props: AccountDialogProps) {
  const [form, setForm] = useState<UpstreamAccountInput>(() =>
    createAccountForm(props.account)
  )

  useEffect(() => {
    if (props.open) setForm(createAccountForm(props.account))
  }, [props.open, props.account])

  const selected = new Set(form.channel_ids ?? [])
  const toggleChannel = (channelId: number, checked: boolean) => {
    const next = new Set(form.channel_ids ?? [])
    if (checked) next.add(channelId)
    else next.delete(channelId)
    setForm({ ...form, channel_ids: [...next] })
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
              <option value='token'>系统访问令牌</option>
              <option value='cookie'>浏览器 Cookie</option>
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
        <div className='grid gap-3 rounded-lg border p-3 sm:grid-cols-2'>
          <Label className='justify-between gap-3'>
            <span>自动签到</span>
            <Switch
              checked={form.auto_checkin}
              onCheckedChange={(checked) =>
                setForm({ ...form, auto_checkin: checked })
              }
            />
          </Label>
          <Label className='justify-between gap-3'>
            <span>自动刷新真实余额</span>
            <Switch
              checked={form.auto_balance}
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
          </div>
        </div>
        <div className='space-y-2'>
          <Label>绑定现有渠道</Label>
          <div className='max-h-52 space-y-1 overflow-y-auto rounded-lg border p-2'>
            {props.channels.length === 0 ? (
              <p className='text-muted-foreground p-2 text-sm'>暂无现有渠道</p>
            ) : (
              props.channels.map((channel) => {
                const occupiedByOther =
                  Boolean(channel.upstream_account_id) &&
                  channel.upstream_account_id !== props.account?.id
                return (
                  <Label
                    key={channel.id}
                    className='hover:bg-muted/50 justify-between rounded-md px-2 py-2'
                  >
                    <span className='min-w-0 truncate'>
                      #{channel.id} · {channel.name}
                      {occupiedByOther && (
                        <span className='text-muted-foreground ml-2 text-xs'>
                          当前绑定：{channel.upstream_account_name}
                        </span>
                      )}
                    </span>
                    <Checkbox
                      checked={selected.has(channel.id)}
                      onCheckedChange={(checked) =>
                        toggleChannel(channel.id, checked === true)
                      }
                    />
                  </Label>
                )
              })
            )}
          </div>
          <p className='text-muted-foreground text-xs'>
            绑定后该渠道默认使用此账号的真实余额；同一渠道重新绑定时会移动到新账号。
          </p>
        </div>
      </div>
    </Dialog>
  )
}

export function UpstreamAccountsPage() {
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<UpstreamAccount | null>(null)
  const [runningKey, setRunningKey] = useState('')

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
              return (
                <div className='grid gap-4 lg:grid-cols-2'>
                  {accountsQuery.data.map((account) => (
                    <Card key={account.id}>
                      <CardHeader className='pb-3'>
                        <div className='flex items-start justify-between gap-3'>
                          <div className='min-w-0'>
                            <CardTitle className='truncate text-base'>
                              {account.name}
                            </CardTitle>
                            <a
                              className='text-muted-foreground hover:text-foreground text-xs'
                              href={account.base_url}
                              target='_blank'
                              rel='noreferrer'
                            >
                              {account.base_url}
                            </a>
                          </div>
                          <div className='flex items-center gap-1'>
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
                                if (
                                  window.confirm(
                                    `确定删除“${account.name}”及其执行日志吗？绑定渠道会恢复使用原渠道接口。`
                                  )
                                ) {
                                  deleteMutation.mutate(account.id)
                                }
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
                          <p>
                            绑定渠道：
                            {account.channel_ids.length
                              ? account.channel_ids
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
                            disabled={runningKey !== ''}
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
                            disabled={runningKey !== ''}
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
                            disabled={runningKey !== ''}
                          >
                            {runningKey === `${account.id}:health` ? (
                              <Loader2 className='animate-spin' />
                            ) : (
                              <HeartPulse />
                            )}
                            检查
                          </Button>
                        </div>
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
            <CardHeader>
              <CardTitle className='flex items-center gap-2 text-sm'>
                <CircleDollarSign className='size-4' />
                渠道余额来源
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className='overflow-x-auto'>
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
                          {channel.upstream_account_name || '—'}
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
                              disabled={!channel.upstream_account_id}
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
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className='flex items-center gap-2 text-sm'>
                <Activity className='size-4' />
                执行日志
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className='overflow-x-auto'>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>时间</TableHead>
                      <TableHead>站点账号</TableHead>
                      <TableHead>操作</TableHead>
                      <TableHead>触发</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>结果</TableHead>
                      <TableHead className='text-right'>耗时</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(logsQuery.data ?? []).map((log) => (
                      <TableRow key={log.id}>
                        <TableCell className='whitespace-nowrap'>
                          {formatTime(log.created_at)}
                        </TableCell>
                        <TableCell>
                          {accountNames.get(log.account_id) ||
                            `#${log.account_id}`}
                        </TableCell>
                        <TableCell>
                          {
                            {
                              checkin: '签到',
                              balance: '余额',
                              health: '健康检查',
                            }[log.type]
                          }
                        </TableCell>
                        <TableCell>
                          {log.trigger === 'scheduled' ? '定时' : '手动'}
                        </TableCell>
                        <TableCell>{statusBadge(log.status)}</TableCell>
                        <TableCell
                          className='max-w-80 truncate'
                          title={log.message}
                        >
                          {log.type === 'balance' && log.status === 'healthy'
                            ? formatBalance(log.balance, log.unit)
                            : log.message || '—'}
                        </TableCell>
                        <TableCell className='text-right'>
                          {log.duration_ms} ms
                        </TableCell>
                      </TableRow>
                    ))}
                    {!logsQuery.isLoading &&
                      (logsQuery.data ?? []).length === 0 && (
                        <TableRow>
                          <TableCell colSpan={7} className='text-center'>
                            暂无执行日志
                          </TableCell>
                        </TableRow>
                      )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </div>
        <AccountDialog
          open={dialogOpen}
          account={editing}
          channels={channelsQuery.data ?? []}
          saving={saveMutation.isPending}
          onOpenChange={(open) => {
            setDialogOpen(open)
            if (!open) setEditing(null)
          }}
          onSave={(input) => saveMutation.mutate(input)}
        />
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
