/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/
import { CalendarCheck2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import {
  SideDrawerSection,
  SideDrawerSectionHeader,
} from '@/components/drawer-layout'

type ChannelUpstreamAccountSectionProps = {
  children: ReactNode
}

export function ChannelUpstreamAccountSection(
  props: ChannelUpstreamAccountSectionProps
) {
  const { t } = useTranslation()

  return (
    <SideDrawerSection className='min-w-0'>
      <SideDrawerSectionHeader
        title={t('Automatic Check-in')}
        description={t(
          'Link the upstream site’s check-in pages, and add the accounts that check in on this channel.'
        )}
        icon={<CalendarCheck2 className='h-4 w-4' aria-hidden='true' />}
        iconTone='warning'
      />
      {props.children}
    </SideDrawerSection>
  )
}
