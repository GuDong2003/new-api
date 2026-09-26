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
import type { DeepPartial } from 'react-hook-form'
import { z } from 'zod'

import { isHttpUrl } from '@/lib/content-format'

import {
  CLAUDE_FIELD_PASSTHROUGH_TYPES,
  CHANNEL_TYPE_ANTHROPIC,
  CHANNEL_TYPE_CLAUDE_CODE,
  CHANNEL_TYPE_CODE_BUDDY,
  CHANNEL_TYPE_CODEX_LEGACY,
  CHANNEL_TYPE_CODEX,
  CHANNEL_TYPE_NEW_API,
  CHANNEL_TYPE_NOVELAI,
  CHANNEL_TYPE_OLLAMA,
  CHANNEL_TYPE_OPENAI,
  CHANNEL_TYPE_TASK_PLUGIN,
  CHANNEL_TYPE_VLLM,
  CHANNEL_TYPE_SGLANG,
  CHANNEL_STATUS,
  ERROR_MESSAGES,
  FIELD_PASSTHROUGH_TYPES,
  MODEL_FETCHABLE_TYPES,
  OPENAI_FIELD_PASSTHROUGH_TYPES,
} from '../constants'
import type { Channel, ChannelUpstreamAccountConfig } from '../types'
import {
  CHANNEL_TYPE_ADVANCED_CUSTOM,
  advancedCustomConfigUsesRelativeUpstreamPath,
  hasValidAdvancedCustomModelListRoute,
  parseAdvancedCustomConfig,
  stringifyAdvancedCustomConfig,
  validateAdvancedCustomConfig,
} from './advanced-custom'
import { readTaskExtendPluginKeys } from './channel-plugin-extensions'
import { getDefaultBaseUrl } from './channel-type-config'
import { supportsResponsesWebSocket } from './responses-websocket'
import { getChannelCheckinLinks } from './upstream-account-display'

export function supportsChannelKeyAppend(
  type: number,
  vertexKeyType: 'json' | 'api_key' | undefined
): boolean {
  return type !== 57 && !(type === 41 && vertexKeyType === 'api_key')
}

export const CLIENT_IDENTITY_CHANNEL_TYPES = new Set([
  CHANNEL_TYPE_OPENAI,
  CHANNEL_TYPE_ANTHROPIC,
  CHANNEL_TYPE_CODEX_LEGACY,
  CHANNEL_TYPE_CODEX,
  CHANNEL_TYPE_CLAUDE_CODE,
  CHANNEL_TYPE_CODE_BUDDY,
])

export const CLIENT_IDENTITY_DEFAULTS: Record<
  number,
  {
    client_type:
      | 'none'
      | 'codex'
      | 'claude'
      | 'claude_code'
      | 'codebuddy'
      | 'workbuddy'
    profile: string
  }
> = {
  [CHANNEL_TYPE_OPENAI]: { client_type: 'none', profile: 'none' },
  [CHANNEL_TYPE_ANTHROPIC]: { client_type: 'none', profile: 'none' },
  [CHANNEL_TYPE_CODEX_LEGACY]: {
    client_type: 'codex',
    profile: 'codex_legacy',
  },
  [CHANNEL_TYPE_CODEX]: {
    client_type: 'codex',
    profile: 'codex_compatibility',
  },
  [CHANNEL_TYPE_CLAUDE_CODE]: {
    client_type: 'claude_code',
    profile: 'claude_code',
  },
  [CHANNEL_TYPE_CODE_BUDDY]: {
    client_type: 'codebuddy',
    profile: 'codebuddy',
  },
}
const LIGHTWEIGHT_CLIENT_IDENTITY_PROFILES = new Set([
  'none',
  'codex_cli',
  'claude_cli',
  'codebuddy_cli',
  'workbuddy_desktop',
])

function isClientIdentityProfileAllowed(
  channelType: number,
  profile: string,
  defaultProfile: string
): boolean {
  if (
    channelType === CHANNEL_TYPE_OPENAI ||
    channelType === CHANNEL_TYPE_ANTHROPIC
  ) {
    return LIGHTWEIGHT_CLIENT_IDENTITY_PROFILES.has(profile)
  }
  return profile === defaultProfile
}

function getClientTypeForProfile(
  profile: string,
  fallback: ChannelFormValues['client_identity_client_type']
): ChannelFormValues['client_identity_client_type'] {
  switch (profile) {
    case 'none':
      return 'none'
    case 'codex_cli':
    case 'codex_legacy':
    case 'codex_compatibility':
      return 'codex'
    case 'claude_cli':
      return 'claude'
    case 'claude_code':
      return 'claude_code'
    case 'codebuddy_cli':
    case 'codebuddy':
      return 'codebuddy'
    case 'workbuddy_desktop':
      return 'workbuddy'
    default:
      return fallback
  }
}
export function getClientIdentitySourceForProfile(
  profile: string | undefined,
  platform?: string
): 'manual' | 'official' {
  switch (profile) {
    case 'codex_legacy':
    case 'codex_compatibility':
    case 'codex_cli':
    case 'claude_code':
    case 'claude_cli':
      return 'official'
    case 'codebuddy':
      return !platform || platform === 'windows-x64' ? 'official' : 'manual'
    default:
      return 'manual'
  }
}
// ============================================================================
// Form Validation Schema
// ============================================================================

const SUPPORTED_PROXY_PROTOCOLS = new Set([
  'http:',
  'https:',
  'socks5:',
  'socks5h:',
])

function isOptionalProxyURL(value: string | undefined): boolean {
  const trimmedValue = value?.trim() || ''
  if (!trimmedValue) return true

  const schemeSeparatorIndex = trimmedValue.indexOf('://')
  if (schemeSeparatorIndex <= 0) return false

  const authorityAndSuffix = trimmedValue.slice(schemeSeparatorIndex + 3)
  const suffixIndex = authorityAndSuffix.search(/[/?#]/)
  if (suffixIndex >= 0 && authorityAndSuffix.slice(suffixIndex) !== '/') {
    return false
  }

  try {
    const parsedURL = new URL(trimmedValue)
    return (
      SUPPORTED_PROXY_PROTOCOLS.has(parsedURL.protocol) &&
      Boolean(parsedURL.hostname) &&
      parsedURL.port !== '0'
    )
  } catch {
    return false
  }
}

export const HTTP_PROTOCOL_AUTO = 'auto'
export const HTTP_PROTOCOL_HTTP1 = 'http1'
export const MAX_HTTP2_CONNECTION_SHARDS = 8

export function normalizeHttpProtocol(
  value: string | undefined | null
): 'auto' | 'http1' {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
  if (normalized === HTTP_PROTOCOL_HTTP1) {
    return HTTP_PROTOCOL_HTTP1
  }
  return HTTP_PROTOCOL_AUTO
}

export function normalizeHttp2ConnectionShards(
  value: number | undefined | null
): number {
  if (value == null || Number.isNaN(value) || value === 0) {
    return 1
  }
  if (value < 1) {
    return 1
  }
  if (value > MAX_HTTP2_CONNECTION_SHARDS) {
    return MAX_HTTP2_CONNECTION_SHARDS
  }
  return value
}

function parseOptionalJson(value: string | undefined): unknown {
  if (!value?.trim()) return undefined
  return JSON.parse(value)
}

function isJsonObjectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOptionalJsonObject(value: string | undefined): boolean {
  try {
    const parsed = parseOptionalJson(value)
    return parsed === undefined || isJsonObjectValue(parsed)
  } catch {
    return false
  }
}

function isOptionalModelMapping(value: string | undefined): boolean {
  try {
    const parsed = parseOptionalJson(value)
    if (parsed === undefined) return true
    if (!isJsonObjectValue(parsed)) return false
    return Object.values(parsed).every((item) => typeof item === 'string')
  } catch {
    return false
  }
}

function isOptionalStatusCodeMapping(value: string | undefined): boolean {
  try {
    const parsed = parseOptionalJson(value)
    if (parsed === undefined) return true
    if (!isJsonObjectValue(parsed)) return false
    return Object.entries(parsed).every(([from, to]) => {
      const fromCode = Number(from)
      const toCode = Number(to)
      return (
        Number.isInteger(fromCode) &&
        Number.isInteger(toCode) &&
        fromCode >= 100 &&
        fromCode <= 599 &&
        toCode >= 100 &&
        toCode <= 599
      )
    })
  } catch {
    return false
  }
}

function isCodexCredential(value: string | undefined): boolean {
  try {
    const parsed = parseOptionalJson(value)
    if (parsed === undefined) return true
    return (
      isJsonObjectValue(parsed) &&
      typeof parsed.access_token === 'string' &&
      parsed.access_token.trim().length > 0 &&
      typeof parsed.account_id === 'string' &&
      parsed.account_id.trim().length > 0
    )
  } catch {
    return false
  }
}

function isVertexJsonKey(value: string | undefined): boolean {
  try {
    const parsed = parseOptionalJson(value)
    if (parsed === undefined) return true
    if (Array.isArray(parsed)) {
      return parsed.every((item) => isJsonObjectValue(item))
    }
    return isJsonObjectValue(parsed)
  } catch {
    return false
  }
}

function addRequiredIssue(
  ctx: z.RefinementCtx,
  path: string,
  message: string
): void {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [path],
    message,
  })
}

// One account that checks in on the channel. An account without an id is new
// and needs a credential; a saved one keeps its credential when left empty.
const upstreamAccountFormSchema = z.object({
  id: z.number().optional(),
  name: z.string(),
  auth_type: z.enum(['token', 'cookie']),
  user_id: z.number().int().nonnegative().optional(),
  credential: z.string(),
  auto_checkin: z.boolean(),
})

export type UpstreamAccountFormValues = z.infer<
  typeof upstreamAccountFormSchema
>

// The fields the check-in accounts are built from, besides the channel's own
// address. A save that changes none of them leaves the saved accounts alone.
export const CHECKIN_FORM_FIELDS = [
  'upstream_accounts',
  'upstream_account_site_type',
  'upstream_account_auto_balance',
  'upstream_account_balance_interval',
  'external_checkin_url',
  'redeem_url',
  'open_redeem_with_checkin',
] as const

export const EMPTY_UPSTREAM_ACCOUNT: UpstreamAccountFormValues = {
  name: '',
  auth_type: 'token',
  user_id: undefined,
  credential: '',
  auto_checkin: true,
}

export const channelFormSchema = z
  .object({
    name: z.string().min(1, ERROR_MESSAGES.REQUIRED_NAME),
    type: z.number().min(0, ERROR_MESSAGES.REQUIRED_TYPE),
    base_url: z.string().optional(),
    task_plugin_key: z.string().optional(),
    task_extend_plugin_keys: z.array(z.string()).optional(),
    key: z.string(),
    openai_organization: z.string().optional(),
    models: z.string().min(1, ERROR_MESSAGES.REQUIRED_MODELS),
    group: z.array(z.string()).min(1, ERROR_MESSAGES.REQUIRED_GROUP),
    model_mapping: z
      .string()
      .optional()
      .refine(
        isOptionalModelMapping,
        'Model mapping must be a JSON object with string values'
      ),
    priority: z.number().optional(),
    weight: z.number().optional(),
    test_model: z.string().optional(),
    auto_ban: z.number().optional(),
    status: z.number(),
    status_code_mapping: z
      .string()
      .optional()
      .refine(
        isOptionalStatusCodeMapping,
        'Status code mapping must use valid HTTP status codes'
      ),
    tag: z.string().optional(),
    remark: z
      .string()
      .max(255, 'Remark must be less than 255 characters')
      .optional(),
    setting: z
      .string()
      .optional()
      .refine(isOptionalJsonObject, ERROR_MESSAGES.INVALID_JSON),
    param_override: z
      .string()
      .optional()
      .refine(isOptionalJsonObject, ERROR_MESSAGES.INVALID_JSON),
    header_override: z
      .string()
      .optional()
      .refine(isOptionalJsonObject, ERROR_MESSAGES.INVALID_JSON),
    settings: z
      .string()
      .optional()
      .refine(isOptionalJsonObject, ERROR_MESSAGES.INVALID_JSON),
    advanced_custom: z.string().optional(),
    other: z.string().optional(),
    // Multi-key options (not sent to backend directly)
    multi_key_mode: z.enum(['single', 'batch', 'multi_to_single']).optional(),
    multi_key_type: z.enum(['random', 'polling']).optional(),
    batch_add_set_key_prefix_2_name: z.boolean().optional(),
    key_mode: z.enum(['append', 'replace']).optional(), // For editing multi-key channels
    // Channel extra settings (stored in setting JSON, not sent directly)
    force_format: z.boolean().optional(),
    thinking_to_content: z.boolean().optional(),
    proxy: z
      .string()
      .optional()
      .refine(isOptionalProxyURL, ERROR_MESSAGES.INVALID_PROXY),
    http_protocol: z.enum(['auto', 'http1']).optional(),
    http2_connection_shards: z.number().int().optional(),
    pass_through_body_enabled: z.boolean().optional(),
    responses_websocket_enabled: z.boolean().optional(),
    system_prompt: z.string().optional(),
    system_prompt_override: z.boolean().optional(),
    // Type-specific settings (stored in settings JSON)
    is_enterprise_account: z.boolean().optional(), // OpenRouter specific
    vertex_key_type: z.enum(['json', 'api_key']).optional(), // Vertex AI specific
    aws_key_type: z.enum(['ak_sk', 'api_key']).optional(), // AWS specific
    azure_responses_version: z.string().optional(), // Azure specific
    // Field passthrough controls (stored in settings JSON)
    allow_service_tier: z.boolean().optional(), // OpenAI/Anthropic
    disable_store: z.boolean().optional(), // OpenAI only
    allow_safety_identifier: z.boolean().optional(), // OpenAI only
    allow_include_obfuscation: z.boolean().optional(), // OpenAI: include usage obfuscation
    allow_inference_geo: z.boolean().optional(), // OpenAI/Anthropic: inference geography
    allow_speed: z.boolean().optional(), // Anthropic: speed mode control
    claude_beta_query: z.boolean().optional(), // Anthropic: beta query passthrough
    ollama_openai_chat: z.boolean().optional(), // Ollama: OpenAI-compatible /v1/chat/completions instead of native /api/chat
    disable_task_polling_sleep: z.boolean().optional(),
    // Upstream model update settings (stored in settings JSON)
    upstream_model_update_check_enabled: z.boolean().optional(),
    upstream_model_update_auto_sync_enabled: z.boolean().optional(),
    upstream_model_update_ignored_models: z.string().optional(),
    client_identity_client_type: z
      .enum([
        'none',
        'codex',
        'claude',
        'claude_code',
        'codebuddy',
        'workbuddy',
      ])
      .optional(),
    client_identity_profile: z
      .enum([
        'none',
        'codex_legacy',
        'codex_compatibility',
        'claude_code',
        'codebuddy',
        'codex_cli',
        'claude_cli',
        'codebuddy_cli',
        'workbuddy_desktop',
      ])
      .optional(),
    client_identity_version: z.string().max(64).optional(),
    client_identity_platform: z
      .enum([
        'windows-x64',
        'macos-x64',
        'macos-arm64',
        'linux-x64',
        'linux-arm64',
      ])
      .optional(),
    client_identity_context_1m_enabled: z.boolean().optional(),
    client_identity_source: z
      .enum(['manual', 'official', 'community', 'npm', 'workbuddy'])
      .optional(),
    upstream_accounts: z.array(upstreamAccountFormSchema).optional(),
    upstream_account_site_type: z.string().optional(),
    upstream_account_auto_balance: z.boolean().optional(),
    upstream_account_balance_interval: z.number().int().optional(),
    external_checkin_url: z.string().optional(),
    redeem_url: z.string().optional(),
    open_redeem_with_checkin: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (
      [
        3,
        8,
        36,
        45,
        CHANNEL_TYPE_NEW_API,
        CHANNEL_TYPE_CODEX,
        CHANNEL_TYPE_CLAUDE_CODE,
        CHANNEL_TYPE_CODE_BUDDY,
        CHANNEL_TYPE_TASK_PLUGIN,
        CHANNEL_TYPE_NOVELAI,
        CHANNEL_TYPE_VLLM,
        CHANNEL_TYPE_SGLANG,
      ].includes(data.type) &&
      !data.base_url?.trim()
    ) {
      addRequiredIssue(
        ctx,
        'base_url',
        'Base URL is required for this channel type'
      )
    }
    if (
      data.type === CHANNEL_TYPE_TASK_PLUGIN &&
      !data.task_plugin_key?.trim()
    ) {
      addRequiredIssue(ctx, 'task_plugin_key', 'Task plugin is required')
    }

    if (data.type === CHANNEL_TYPE_ADVANCED_CUSTOM) {
      const advancedCustomConfig = parseAdvancedCustomConfig(
        data.advanced_custom
      )
      const advancedCustomError =
        validateAdvancedCustomConfig(advancedCustomConfig)
      if (advancedCustomError) {
        addRequiredIssue(ctx, 'advanced_custom', advancedCustomError.message)
      }
      if (
        advancedCustomConfigUsesRelativeUpstreamPath(advancedCustomConfig) &&
        !data.base_url?.trim()
      ) {
        addRequiredIssue(
          ctx,
          'base_url',
          'Base URL is required when an advanced route uses an upstream path'
        )
      }
      if (
        data.upstream_model_update_check_enabled === true &&
        !hasValidAdvancedCustomModelListRoute(advancedCustomConfig)
      ) {
        addRequiredIssue(
          ctx,
          'upstream_model_update_check_enabled',
          'OpenAI Models route is required to enable upstream model checks'
        )
      }
    }

    if ([3, 18, 21, 39, 41, 49].includes(data.type) && !data.other?.trim()) {
      addRequiredIssue(
        ctx,
        'other',
        'This channel type requires additional configuration'
      )
    }

    if (data.type === 57) {
      if (data.multi_key_mode && data.multi_key_mode !== 'single') {
        addRequiredIssue(
          ctx,
          'multi_key_mode',
          'Codex channels do not support batch creation'
        )
      }
      if (data.key?.trim() && !isCodexCredential(data.key)) {
        addRequiredIssue(
          ctx,
          'key',
          'Codex credential must be a JSON object with access_token and account_id'
        )
      }
    }

    if (
      data.type === 41 &&
      data.vertex_key_type === 'json' &&
      data.key?.trim() &&
      !isVertexJsonKey(data.key)
    ) {
      addRequiredIssue(
        ctx,
        'key',
        'Vertex AI service account key must be valid JSON'
      )
    }

    if (
      data.type === 41 &&
      data.vertex_key_type === 'api_key' &&
      data.multi_key_mode &&
      data.multi_key_mode !== 'single'
    ) {
      addRequiredIssue(
        ctx,
        'multi_key_mode',
        'Vertex AI API Key mode does not support batch creation'
      )
    }

    const upstreamAccounts = data.upstream_accounts ?? []
    if (
      upstreamAccounts.length > 0 &&
      !getEffectiveChannelBaseUrl(data.type, data.base_url)
    ) {
      addRequiredIssue(
        ctx,
        'base_url',
        'Base URL is required for this channel type'
      )
    }
    if (
      upstreamAccounts.length > 0 &&
      (data.upstream_account_balance_interval ?? 60) < 5
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['upstream_account_balance_interval'],
        message: 'Balance refresh interval cannot be less than 5 minutes',
      })
    }
    for (const [index, account] of upstreamAccounts.entries()) {
      if (!account.id && !account.credential.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['upstream_accounts', index, 'credential'],
          message: 'Enter a credential for the new account',
        })
      }
    }
    for (const field of ['external_checkin_url', 'redeem_url'] as const) {
      const url = data[field]?.trim()
      if (url && !isHttpUrl(url)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: 'Enter an address starting with http:// or https://',
        })
      }
    }

    const protocol = normalizeHttpProtocol(data.http_protocol)
    const shards = data.http2_connection_shards ?? 1
    if (shards < 1 || shards > MAX_HTTP2_CONNECTION_SHARDS) {
      addRequiredIssue(
        ctx,
        'http2_connection_shards',
        ERROR_MESSAGES.INVALID_HTTP2_CONNECTION_SHARDS
      )
    }
    if (protocol === HTTP_PROTOCOL_HTTP1 && shards > 1) {
      addRequiredIssue(
        ctx,
        'http2_connection_shards',
        ERROR_MESSAGES.INVALID_HTTP1_WITH_SHARDS
      )
    }
  })

export type ChannelFormValues = z.infer<typeof channelFormSchema>

// ============================================================================
// Default Form Values
// ============================================================================

export const CHANNEL_FORM_DEFAULT_VALUES: ChannelFormValues = {
  name: '',
  type: 1,
  base_url: '',
  task_plugin_key: '',
  task_extend_plugin_keys: [],
  key: '',
  openai_organization: '',
  models: '',
  group: ['default'],
  model_mapping: '',
  priority: 0,
  weight: 0,
  test_model: '',
  auto_ban: 1,
  status: CHANNEL_STATUS.ENABLED,
  status_code_mapping: '',
  tag: '',
  remark: '',
  setting: '',
  param_override: '',
  header_override: '',
  settings: '{}',
  other: '',
  multi_key_mode: 'single',
  multi_key_type: 'random',
  batch_add_set_key_prefix_2_name: false,
  key_mode: 'append',
  // Channel extra settings
  force_format: false,
  thinking_to_content: false,
  proxy: '',
  http_protocol: HTTP_PROTOCOL_AUTO,
  http2_connection_shards: 1,
  pass_through_body_enabled: false,
  responses_websocket_enabled: false,
  system_prompt: '',
  system_prompt_override: false,
  // Type-specific settings
  is_enterprise_account: false,
  vertex_key_type: 'json',
  aws_key_type: 'ak_sk',
  azure_responses_version: '',
  // Field passthrough controls
  allow_service_tier: false,
  disable_store: false,
  allow_safety_identifier: false,
  allow_include_obfuscation: false,
  allow_inference_geo: false,
  allow_speed: false,
  claude_beta_query: false,
  ollama_openai_chat: false,
  disable_task_polling_sleep: false,
  upstream_model_update_check_enabled: false,
  upstream_model_update_auto_sync_enabled: false,
  upstream_model_update_ignored_models: '',
  client_identity_client_type: undefined,
  client_identity_profile: undefined,
  client_identity_version: '',
  client_identity_platform: undefined,
  client_identity_context_1m_enabled: false,
  client_identity_source: 'manual',
  advanced_custom: '',
  upstream_accounts: [],
  upstream_account_site_type: 'new_api',
  upstream_account_auto_balance: true,
  upstream_account_balance_interval: 60,
  external_checkin_url: '',
  redeem_url: '',
  open_redeem_with_checkin: false,
}

// ============================================================================
// Transform Functions
// ============================================================================

/**
 * Transform Channel from API to Form default values
 */
export function transformChannelToFormDefaults(
  channel: Channel
): ChannelFormValues {
  // Parse channel extra settings from setting field
  let extraSettings = {
    task_plugin_key: '',
    task_extend_plugin_keys: [] as string[],
    force_format: false,
    thinking_to_content: false,
    proxy: '',
    http_protocol: HTTP_PROTOCOL_AUTO as 'auto' | 'http1',
    http2_connection_shards: 1,
    pass_through_body_enabled: false,
    responses_websocket_enabled: false,
    system_prompt: '',
    system_prompt_override: false,
  }

  if (channel.setting) {
    try {
      const parsed = JSON.parse(channel.setting)
      const protocol = normalizeHttpProtocol(parsed.http_protocol)
      const shards = normalizeHttp2ConnectionShards(
        parsed.http2_connection_shards
      )
      extraSettings = {
        task_plugin_key: parsed.task_plugin_key || '',
        task_extend_plugin_keys: readTaskExtendPluginKeys(channel.type, parsed),
        force_format: parsed.force_format || false,
        thinking_to_content: parsed.thinking_to_content || false,
        proxy: parsed.proxy || '',
        http_protocol: protocol,
        http2_connection_shards: protocol === HTTP_PROTOCOL_HTTP1 ? 1 : shards,
        pass_through_body_enabled: parsed.pass_through_body_enabled || false,
        responses_websocket_enabled:
          parsed.responses_websocket_enabled === true,
        system_prompt: parsed.system_prompt || '',
        system_prompt_override: parsed.system_prompt_override || false,
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to parse channel setting:', error)
    }
  }

  // Parse type-specific settings from settings field
  let vertexKeyType: 'json' | 'api_key' = 'json'
  let azureResponsesVersion = ''
  let isEnterpriseAccount = false
  let awsKeyType: 'ak_sk' | 'api_key' = 'ak_sk'
  let allowServiceTier = false
  let disableStore = false
  let allowSafetyIdentifier = false
  let allowIncludeObfuscation = false
  let allowInferenceGeo = false
  let allowSpeed = false
  let claudeBetaQuery = false
  let ollamaOpenAIChat = false
  let disableTaskPollingSleep = false
  let upstreamModelUpdateCheckEnabled = false
  let upstreamModelUpdateAutoSyncEnabled = false
  let upstreamModelUpdateIgnoredModels = ''
  let advancedCustom = ''
  let clientIdentityClientType: ChannelFormValues['client_identity_client_type']
  let clientIdentityProfile: ChannelFormValues['client_identity_profile']
  let clientIdentityVersion = ''
  let clientIdentityPlatform: ChannelFormValues['client_identity_platform']
  let clientIdentityContext1MEnabled = false
  let clientIdentitySource: ChannelFormValues['client_identity_source']

  if (channel.settings) {
    try {
      const parsed = JSON.parse(channel.settings)
      vertexKeyType = parsed.vertex_key_type || 'json'
      azureResponsesVersion = parsed.azure_responses_version || ''
      isEnterpriseAccount = parsed.openrouter_enterprise === true
      awsKeyType = parsed.aws_key_type || 'ak_sk'
      allowServiceTier = parsed.allow_service_tier === true
      disableStore = parsed.disable_store === true
      allowSafetyIdentifier = parsed.allow_safety_identifier === true
      allowIncludeObfuscation = parsed.allow_include_obfuscation === true
      allowInferenceGeo = parsed.allow_inference_geo === true
      allowSpeed = parsed.allow_speed === true
      claudeBetaQuery = parsed.claude_beta_query === true
      ollamaOpenAIChat = parsed.ollama_openai_chat === true
      disableTaskPollingSleep = parsed.disable_task_polling_sleep === true
      upstreamModelUpdateCheckEnabled =
        parsed.upstream_model_update_check_enabled === true
      upstreamModelUpdateAutoSyncEnabled =
        parsed.upstream_model_update_auto_sync_enabled === true
      upstreamModelUpdateIgnoredModels = Array.isArray(
        parsed.upstream_model_update_ignored_models
      )
        ? parsed.upstream_model_update_ignored_models.join(',')
        : ''
      if (
        parsed.client_identity &&
        typeof parsed.client_identity === 'object'
      ) {
        const clientIdentity = parsed.client_identity as Record<string, unknown>
        if (
          clientIdentity.client_type === 'none' ||
          clientIdentity.client_type === 'codex' ||
          clientIdentity.client_type === 'claude' ||
          clientIdentity.client_type === 'claude_code' ||
          clientIdentity.client_type === 'codebuddy' ||
          clientIdentity.client_type === 'workbuddy'
        ) {
          clientIdentityClientType = clientIdentity.client_type
        }
        if (
          clientIdentity.profile === 'none' ||
          clientIdentity.profile === 'codex_legacy' ||
          clientIdentity.profile === 'codex_compatibility' ||
          clientIdentity.profile === 'claude_code' ||
          clientIdentity.profile === 'codebuddy' ||
          clientIdentity.profile === 'codex_cli' ||
          clientIdentity.profile === 'claude_cli' ||
          clientIdentity.profile === 'codebuddy_cli' ||
          clientIdentity.profile === 'workbuddy_desktop'
        ) {
          clientIdentityProfile = clientIdentity.profile
        }
        if (typeof clientIdentity.version === 'string') {
          clientIdentityVersion = clientIdentity.version
        }
        if (
          clientIdentity.platform === 'windows-x64' ||
          clientIdentity.platform === 'macos-x64' ||
          clientIdentity.platform === 'macos-arm64' ||
          clientIdentity.platform === 'linux-x64' ||
          clientIdentity.platform === 'linux-arm64'
        ) {
          clientIdentityPlatform = clientIdentity.platform
        }
        clientIdentityContext1MEnabled =
          clientIdentity.context_1m_enabled === true
        if (
          clientIdentity.source &&
          typeof clientIdentity.source === 'object' &&
          'kind' in clientIdentity.source &&
          (clientIdentity.source.kind === 'manual' ||
            clientIdentity.source.kind === 'official' ||
            clientIdentity.source.kind === 'community' ||
            clientIdentity.source.kind === 'npm' ||
            clientIdentity.source.kind === 'workbuddy')
        ) {
          clientIdentitySource = clientIdentity.source.kind
        }
      }
      if (parsed.advanced_custom) {
        advancedCustom = stringifyAdvancedCustomConfig(parsed.advanced_custom)
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to parse channel settings:', error)
    }
  }
  const upstreamAccounts = channel.upstream_account_configs ?? []
  const checkinLinks = getChannelCheckinLinks(channel)

  return {
    name: channel.name || '',
    type: channel.type,
    base_url: channel.base_url || '',
    key: '', // Never populate key from backend for security
    openai_organization: channel.openai_organization || '',
    models: channel.models || '',
    group: parseGroups(channel.group || 'default'),
    model_mapping: channel.model_mapping || '',
    priority: channel.priority || 0,
    weight: channel.weight || 0,
    test_model: channel.test_model || '',
    auto_ban: channel.auto_ban ?? 1,
    status: channel.status,
    status_code_mapping: channel.status_code_mapping || '',
    tag: channel.tag || '',
    remark: channel.remark || '',
    setting: channel.setting || '',
    param_override: channel.param_override || '',
    header_override: channel.header_override || '',
    settings: channel.settings || '{}',
    other: channel.other || '',
    multi_key_mode: 'single',
    multi_key_type: channel.channel_info.multi_key_mode || 'random',
    batch_add_set_key_prefix_2_name: false,
    key_mode: 'append', // Default to append mode for editing multi-key channels
    // Channel extra settings
    ...extraSettings,
    // Type-specific settings
    is_enterprise_account: isEnterpriseAccount,
    vertex_key_type: vertexKeyType,
    azure_responses_version: azureResponsesVersion,
    aws_key_type: awsKeyType,
    allow_service_tier: allowServiceTier,
    disable_store: disableStore,
    allow_include_obfuscation: allowIncludeObfuscation,
    allow_inference_geo: allowInferenceGeo,
    allow_speed: allowSpeed,
    claude_beta_query: claudeBetaQuery,
    ollama_openai_chat: ollamaOpenAIChat,
    disable_task_polling_sleep: disableTaskPollingSleep,
    allow_safety_identifier: allowSafetyIdentifier,
    upstream_model_update_check_enabled: upstreamModelUpdateCheckEnabled,
    upstream_model_update_auto_sync_enabled: upstreamModelUpdateAutoSyncEnabled,
    upstream_model_update_ignored_models: upstreamModelUpdateIgnoredModels,
    client_identity_client_type: clientIdentityClientType,
    client_identity_profile: clientIdentityProfile,
    client_identity_version: clientIdentityVersion,
    client_identity_platform: clientIdentityPlatform,
    client_identity_context_1m_enabled: clientIdentityContext1MEnabled,
    client_identity_source: clientIdentitySource || 'manual',
    advanced_custom: advancedCustom,
    upstream_accounts: upstreamAccounts.map((account) => ({
      id: account.id,
      name: account.name ?? '',
      auth_type: account.auth_type ?? 'token',
      user_id: account.user_id || undefined,
      credential: '',
      auto_checkin: account.auto_checkin === true,
    })),
    // The site settings are one per channel; every account carries a copy.
    upstream_account_site_type: upstreamAccounts[0]?.site_type || 'new_api',
    upstream_account_auto_balance: upstreamAccounts[0]?.auto_balance ?? true,
    upstream_account_balance_interval:
      upstreamAccounts[0]?.balance_interval || 60,
    external_checkin_url: checkinLinks.externalCheckinUrl,
    redeem_url: checkinLinks.redeemUrl,
    open_redeem_with_checkin: checkinLinks.openRedeemWithCheckin,
  }
}

/**
 * Build the setting JSON string from form extra settings
 */
export function buildSettingJSON(formData: ChannelFormValues): string {
  const settingObj: Record<string, unknown> = {
    task_plugin_key:
      formData.type === CHANNEL_TYPE_TASK_PLUGIN
        ? formData.task_plugin_key?.trim() || ''
        : undefined,
    task_extend_plugin_keys:
      formData.type === CHANNEL_TYPE_NEW_API &&
      formData.task_extend_plugin_keys?.length
        ? formData.task_extend_plugin_keys
        : undefined,
    force_format: formData.force_format || false,
    thinking_to_content: formData.thinking_to_content || false,
    proxy: formData.proxy?.trim() || '',
    pass_through_body_enabled:
      formData.type !== CHANNEL_TYPE_ADVANCED_CUSTOM &&
      formData.pass_through_body_enabled === true,
    responses_websocket_enabled:
      supportsResponsesWebSocket(formData.type) &&
      formData.responses_websocket_enabled === true,
    system_prompt: formData.system_prompt || '',
    system_prompt_override: formData.system_prompt_override || false,
  }

  const protocol = normalizeHttpProtocol(formData.http_protocol)
  const shards =
    protocol === HTTP_PROTOCOL_HTTP1
      ? 1
      : normalizeHttp2ConnectionShards(formData.http2_connection_shards)

  // Omit defaults so unchanged channels keep equivalent JSON.
  if (protocol === HTTP_PROTOCOL_HTTP1) {
    settingObj.http_protocol = HTTP_PROTOCOL_HTTP1
  } else if (shards > 1) {
    settingObj.http2_connection_shards = shards
  }

  return JSON.stringify(settingObj)
}

/**
 * Build the settings JSON string (for type-specific config like vertex_key_type)
 */
export function buildSettingsJSON(formData: ChannelFormValues): string {
  let settingsObj: Record<string, unknown> = {}

  // Try to parse existing settings first
  if (formData.settings && formData.settings !== '{}') {
    try {
      settingsObj = JSON.parse(formData.settings)
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to parse existing settings:', error)
    }
  }

  // Add vertex_key_type for Vertex AI channels (type 41)
  if (formData.type === 41) {
    settingsObj.vertex_key_type = formData.vertex_key_type || 'json'
  } else if ('vertex_key_type' in settingsObj) {
    delete settingsObj.vertex_key_type
  }

  // Add azure_responses_version for Azure channels (type 3)
  if (formData.type === 3 && formData.azure_responses_version) {
    settingsObj.azure_responses_version = formData.azure_responses_version
  } else if ('azure_responses_version' in settingsObj) {
    delete settingsObj.azure_responses_version
  }

  // Add enterprise account setting for OpenRouter (type 20)
  if (formData.type === 20) {
    settingsObj.openrouter_enterprise = formData.is_enterprise_account === true
  } else if ('openrouter_enterprise' in settingsObj) {
    delete settingsObj.openrouter_enterprise
  }

  // Add aws_key_type for AWS channels (type 33)
  if (formData.type === 33) {
    settingsObj.aws_key_type = formData.aws_key_type || 'ak_sk'
  } else if ('aws_key_type' in settingsObj) {
    delete settingsObj.aws_key_type
  }

  // Field passthrough controls:
  // - OpenAI, Anthropic, Codex, and New API: allow_service_tier
  // - OpenAI request fields: OpenAI, Codex, and New API
  // - Claude request fields: Anthropic and New API
  if (FIELD_PASSTHROUGH_TYPES.has(formData.type)) {
    settingsObj.allow_service_tier = formData.allow_service_tier === true
  } else if ('allow_service_tier' in settingsObj) {
    delete settingsObj.allow_service_tier
  }

  if (OPENAI_FIELD_PASSTHROUGH_TYPES.has(formData.type)) {
    settingsObj.disable_store = formData.disable_store === true
    settingsObj.allow_safety_identifier =
      formData.allow_safety_identifier === true
    settingsObj.allow_include_obfuscation =
      formData.allow_include_obfuscation === true
  } else {
    if ('disable_store' in settingsObj) {
      delete settingsObj.disable_store
    }
    if ('allow_safety_identifier' in settingsObj) {
      delete settingsObj.allow_safety_identifier
    }
    if ('allow_include_obfuscation' in settingsObj) {
      delete settingsObj.allow_include_obfuscation
    }
  }

  if (
    OPENAI_FIELD_PASSTHROUGH_TYPES.has(formData.type) ||
    CLAUDE_FIELD_PASSTHROUGH_TYPES.has(formData.type)
  ) {
    settingsObj.allow_inference_geo = formData.allow_inference_geo === true
  } else if ('allow_inference_geo' in settingsObj) {
    delete settingsObj.allow_inference_geo
  }

  if (CLAUDE_FIELD_PASSTHROUGH_TYPES.has(formData.type)) {
    settingsObj.allow_speed = formData.allow_speed === true
  } else if ('allow_speed' in settingsObj) {
    delete settingsObj.allow_speed
  }

  // Only the Anthropic adaptor supports forcing the Claude beta query.
  if (formData.type === 14) {
    settingsObj.claude_beta_query = formData.claude_beta_query === true
  } else if ('claude_beta_query' in settingsObj) {
    delete settingsObj.claude_beta_query
  }

  // Only the Ollama adaptor can switch chat completions to the OpenAI-compatible endpoint.
  if (formData.type === CHANNEL_TYPE_OLLAMA) {
    settingsObj.ollama_openai_chat = formData.ollama_openai_chat === true
  } else if ('ollama_openai_chat' in settingsObj) {
    delete settingsObj.ollama_openai_chat
  }

  settingsObj.disable_task_polling_sleep =
    formData.disable_task_polling_sleep === true

  if (CLIENT_IDENTITY_CHANNEL_TYPES.has(formData.type)) {
    const defaults = CLIENT_IDENTITY_DEFAULTS[formData.type]
    const requestedProfile =
      formData.client_identity_profile || defaults.profile
    const profile = isClientIdentityProfileAllowed(
      formData.type,
      requestedProfile,
      defaults.profile
    )
      ? requestedProfile
      : defaults.profile
    if (profile === 'none') {
      delete settingsObj.client_identity
    } else {
      const clientIdentity: Record<string, unknown> = {
        client_type: getClientTypeForProfile(
          profile,
          formData.client_identity_client_type || defaults.client_type
        ),
        profile,
      }
      if (
        requestedProfile === profile &&
        formData.client_identity_version?.trim()
      ) {
        clientIdentity.version = formData.client_identity_version.trim()
      }
      if (requestedProfile === profile && formData.client_identity_platform) {
        clientIdentity.platform = formData.client_identity_platform
      }
      if (
        requestedProfile === profile &&
        profile === 'claude_code' &&
        formData.client_identity_context_1m_enabled === true
      ) {
        clientIdentity.context_1m_enabled = true
      }
      clientIdentity.source = {
        kind: getClientIdentitySourceForProfile(
          profile,
          requestedProfile === profile
            ? formData.client_identity_platform
            : undefined
        ),
      }
      settingsObj.client_identity = clientIdentity
    }
  } else if ('client_identity' in settingsObj) {
    delete settingsObj.client_identity
  }

  // Upstream model update settings (for model-fetchable channel types)
  if (MODEL_FETCHABLE_TYPES.has(formData.type)) {
    settingsObj.upstream_model_update_check_enabled =
      formData.upstream_model_update_check_enabled === true
    settingsObj.upstream_model_update_auto_sync_enabled =
      settingsObj.upstream_model_update_check_enabled === true &&
      formData.upstream_model_update_auto_sync_enabled === true
    settingsObj.upstream_model_update_ignored_models = [
      ...new Set(
        String(formData.upstream_model_update_ignored_models || '')
          .split(',')
          .map((model) => model.trim())
          .filter(Boolean)
      ),
    ]
    if (
      !Array.isArray(settingsObj.upstream_model_update_last_detected_models) ||
      settingsObj.upstream_model_update_check_enabled !== true
    ) {
      settingsObj.upstream_model_update_last_detected_models = []
    }
    if (typeof settingsObj.upstream_model_update_last_check_time !== 'number') {
      settingsObj.upstream_model_update_last_check_time = 0
    }
  }

  if (formData.type === CHANNEL_TYPE_ADVANCED_CUSTOM) {
    const advancedCustomConfig = parseAdvancedCustomConfig(
      formData.advanced_custom
    )
    if (advancedCustomConfig) {
      settingsObj.advanced_custom = advancedCustomConfig
    }
  } else if ('advanced_custom' in settingsObj) {
    delete settingsObj.advanced_custom
  }

  // The upstream site's check-in and recharge pages belong to the channel, so
  // they are kept whether or not an account checks in on it.
  const externalCheckinUrl = formData.external_checkin_url?.trim()
  const redeemUrl = formData.redeem_url?.trim()
  if (externalCheckinUrl) settingsObj.external_checkin_url = externalCheckinUrl
  else delete settingsObj.external_checkin_url
  if (redeemUrl) settingsObj.redeem_url = redeemUrl
  else delete settingsObj.redeem_url
  if (formData.open_redeem_with_checkin === true) {
    settingsObj.open_redeem_with_checkin = true
  } else {
    delete settingsObj.open_redeem_with_checkin
  }

  return JSON.stringify(settingsObj)
}

function normalizeBaseUrl(value: string | undefined): string {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '')
}

function getEffectiveChannelBaseUrl(
  type: number,
  baseUrl: string | undefined
): string {
  return normalizeBaseUrl(baseUrl) || getDefaultBaseUrl(type)
}

// The accounts that check in on the channel, replacing the saved ones. Each
// carries the channel's site settings; an empty name lets the server name it
// after the channel.
function buildUpstreamAccountConfigsPayload(
  formData: ChannelFormValues
): ChannelUpstreamAccountConfig[] {
  const baseUrl = getEffectiveChannelBaseUrl(formData.type, formData.base_url)
  return (formData.upstream_accounts ?? []).map((account) => {
    const config: ChannelUpstreamAccountConfig = {
      enabled: true,
      id: account.id,
      name: account.name.trim(),
      base_url: baseUrl,
      site_type: formData.upstream_account_site_type || 'new_api',
      auth_type: account.auth_type,
      user_id: account.user_id ?? 0,
      auto_checkin: account.auto_checkin,
      auto_balance: formData.upstream_account_auto_balance !== false,
      balance_interval: formData.upstream_account_balance_interval || 60,
      external_checkin_url: formData.external_checkin_url?.trim() || '',
      redeem_url: formData.redeem_url?.trim() || '',
      open_redeem_with_checkin: formData.open_redeem_with_checkin === true,
    }
    const credential = account.credential.trim()
    if (credential) {
      config.credential = credential
    }
    return config
  })
}

/**
 * Transform form data to API payload for creating channel
 */
export function transformFormDataToCreatePayload(formData: ChannelFormValues): {
  mode: 'single' | 'batch' | 'multi_to_single'
  multi_key_mode?: 'random' | 'polling'
  batch_add_set_key_prefix_2_name?: boolean
  channel: Partial<Channel>
} {
  const mode = formData.multi_key_mode || 'single'

  const channel: Partial<Channel> = {
    name: formData.name,
    type: formData.type,
    base_url: normalizeBaseUrl(formData.base_url) || null,
    key: formData.key,
    openai_organization: formData.openai_organization || null,
    models: formData.models,
    group: formatGroups(formData.group),
    model_mapping: formData.model_mapping || null,
    priority: formData.priority || null,
    weight: formData.weight || null,
    test_model: formData.test_model || null,
    auto_ban: formData.auto_ban ?? 1,
    status: formData.status,
    status_code_mapping: formData.status_code_mapping || null,
    tag: formData.tag || null,
    remark: formData.remark || '',
    setting: buildSettingJSON(formData),
    param_override: formData.param_override || null,
    header_override: formData.header_override || null,
    settings: buildSettingsJSON(formData),
    other: formData.other || '',
    upstream_account_configs: buildUpstreamAccountConfigsPayload(formData),
  }

  // Clean up empty strings to null for optional fields
  Object.keys(channel).forEach((key) => {
    if (channel[key as keyof typeof channel] === '') {
      ;(channel as Record<string, unknown>)[key] = null
    }
  })

  return {
    mode,
    multi_key_mode:
      mode === 'multi_to_single' ? formData.multi_key_type : undefined,
    batch_add_set_key_prefix_2_name:
      mode === 'batch' ? formData.batch_add_set_key_prefix_2_name : undefined,
    channel,
  }
}

/**
 * Transform form data to API payload for updating channel. Given the values
 * the form was loaded with, it leaves the check-in accounts out unless the
 * save changes what they are built from, so a save that only touches routing
 * cannot overwrite accounts added elsewhere since.
 */
export function transformFormDataToUpdatePayload(
  formData: ChannelFormValues,
  channelId: number,
  loaded?: DeepPartial<ChannelFormValues>
): Partial<Channel> {
  const checkinChanged =
    !loaded ||
    getEffectiveChannelBaseUrl(formData.type, formData.base_url) !==
      getEffectiveChannelBaseUrl(
        loaded.type ?? formData.type,
        loaded.base_url
      ) ||
    CHECKIN_FORM_FIELDS.some(
      (field) =>
        JSON.stringify(formData[field] ?? null) !==
        JSON.stringify(loaded[field] ?? null)
    )
  const payload: Partial<Channel> = {
    id: channelId,
    name: formData.name,
    type: formData.type,
    base_url: normalizeBaseUrl(formData.base_url) || null,
    openai_organization: formData.openai_organization || null,
    models: formData.models,
    group: formatGroups(formData.group),
    model_mapping: formData.model_mapping || null,
    priority: formData.priority ?? 0,
    weight: formData.weight ?? 0,
    test_model: formData.test_model || null,
    auto_ban: formData.auto_ban ?? 1,
    status_code_mapping: formData.status_code_mapping || null,
    tag: formData.tag || null,
    remark: formData.remark || '',
    setting: buildSettingJSON(formData),
    param_override: formData.param_override || null,
    header_override: formData.header_override || null,
    settings: buildSettingsJSON(formData),
    other: formData.other || '',
    upstream_account_configs: checkinChanged
      ? buildUpstreamAccountConfigsPayload(formData)
      : undefined,
    // The accounts the form showed, so the server refuses the list if the
    // channel's accounts changed after the form was opened.
    upstream_account_loaded_ids:
      checkinChanged && loaded
        ? (loaded.upstream_accounts ?? []).flatMap((account) =>
            account?.id ? [account.id] : []
          )
        : undefined,
  }

  // Only include key if it was changed (not empty)
  if (formData.key && formData.key.trim()) {
    payload.key = formData.key
  }

  // Clean up empty strings to null for optional fields
  Object.keys(payload).forEach((key) => {
    if (payload[key as keyof typeof payload] === '') {
      ;(payload as Record<string, unknown>)[key] = null
    }
  })

  // Send explicit empty strings for nullable fields so GORM updates can clear them.
  payload.base_url = normalizeBaseUrl(formData.base_url) || ''
  payload.openai_organization = formData.openai_organization || ''
  payload.test_model = formData.test_model || ''
  payload.tag = formData.tag || ''
  payload.remark = formData.remark || ''
  payload.model_mapping = formData.model_mapping || ''
  payload.status_code_mapping = formData.status_code_mapping || ''
  payload.param_override = formData.param_override || ''
  payload.header_override = formData.header_override || ''

  return payload
}

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validate JSON string
 */
export function validateJSON(value: string): boolean {
  if (!value || value.trim() === '') return true
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}

/**
 * Validate model mapping format
 */
export function validateModelMapping(value: string): boolean {
  if (!value || value.trim() === '') return true
  return validateJSON(value)
}

/**
 * Parse models string to array
 */
export function parseModels(models: string): string[] {
  if (!models) return []
  return models
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0)
}

/**
 * Parse groups string to array
 */
export function parseGroups(groups: string): string[] {
  if (!groups) return []
  return groups
    .split(',')
    .map((g) => g.trim())
    .filter((g) => g.length > 0)
}

/**
 * Format models array to string
 */
export function formatModels(models: string[]): string {
  return models.join(',')
}

/**
 * Format groups array to string
 */
export function formatGroups(groups: string[]): string {
  return groups.join(',')
}
