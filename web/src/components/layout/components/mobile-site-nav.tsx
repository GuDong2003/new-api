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
import { Link, useRouterState } from '@tanstack/react-router'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import type { TopNavLink } from '../types'

export type MobileSiteNavProps = {
  links: TopNavLink[]
  /**
   * Rendered under the links while the menu is open, for a call to action such
   * as signing in. Receives a closer so the action can dismiss the menu.
   */
  footer?: (close: () => void) => ReactNode
  /**
   * Called before the menu closes. Preventing the event keeps the app on the
   * current page, which is how the public header raises its sign-in prompt.
   */
  onLinkClick?: (
    event: React.MouseEvent<HTMLAnchorElement>,
    link: TopNavLink
  ) => void
  /** Applied to the trigger; the overlay follows the same lg breakpoint. */
  className?: string
}

/**
 * Site navigation for narrow screens: a hamburger trigger plus a full-screen
 * menu. Every shell renders this same pair so the console and the canvas reach
 * the other pages exactly the way the public pages do.
 *
 * The menu is portaled to the document body because a header that blurs its
 * backdrop becomes the containing block for fixed descendants, which would trap
 * the overlay inside the header.
 */
export function MobileSiteNav(props: MobileSiteNavProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const overlayId = useId()
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  const overlay = (
    <div
      id={overlayId}
      className={cn(
        'bg-background/98 fixed inset-0 z-30 backdrop-blur-2xl transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] lg:pointer-events-none lg:hidden',
        open
          ? 'pointer-events-auto opacity-100'
          : 'pointer-events-none opacity-0'
      )}
    >
      <div className='flex h-full flex-col justify-between px-8 pt-20 pb-10'>
        <nav aria-label={t('Site navigation')} className='flex flex-col gap-1'>
          {props.links.map((link, index) => {
            const isActive = pathname === link.href
            const linkClassName = cn(
              'flex items-center gap-3 py-3 text-base font-medium tracking-tight transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]',
              open ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0',
              isActive ? 'text-foreground' : 'text-muted-foreground',
              link.disabled && 'pointer-events-none opacity-50'
            )
            const transitionStyle = {
              transitionDelay: open ? `${100 + index * 50}ms` : '0ms',
            }
            const handleClick = (
              event: React.MouseEvent<HTMLAnchorElement>
            ) => {
              if (link.disabled) {
                event.preventDefault()
                return
              }
              props.onLinkClick?.(event, link)
              setOpen(false)
            }
            if (link.external) {
              return (
                <a
                  key={`${link.title}:${link.href}`}
                  href={link.href}
                  target='_blank'
                  rel='noopener noreferrer'
                  aria-disabled={link.disabled}
                  tabIndex={link.disabled ? -1 : undefined}
                  onClick={handleClick}
                  className={linkClassName}
                  style={transitionStyle}
                >
                  {t(link.title)}
                </a>
              )
            }
            return (
              <Link
                key={`${link.title}:${link.href}`}
                to={link.href}
                disabled={link.disabled}
                aria-current={isActive ? 'page' : undefined}
                onClick={handleClick}
                className={linkClassName}
                style={transitionStyle}
              >
                {t(link.title)}
              </Link>
            )
          })}
        </nav>

        {props.footer && (
          <div
            className={cn(
              'flex flex-col gap-3 transition-all duration-500',
              open ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'
            )}
            style={{ transitionDelay: open ? '250ms' : '0ms' }}
          >
            {props.footer(() => setOpen(false))}
          </div>
        )}
      </div>
    </div>
  )

  return (
    <>
      <Button
        type='button'
        variant='ghost'
        size='icon'
        className={cn('size-9', props.className)}
        aria-label={t('Toggle navigation menu')}
        aria-expanded={open}
        aria-controls={overlayId}
        onClick={() => setOpen((value) => !value)}
      >
        <div className='relative size-4'>
          <span
            className={cn(
              'absolute inset-x-0 block h-[1.5px] origin-center rounded-full bg-current transition-all duration-300',
              open ? 'top-[7px] rotate-45' : 'top-[3px]'
            )}
          />
          <span
            className={cn(
              'absolute inset-x-0 top-[7px] block h-[1.5px] rounded-full bg-current transition-all duration-300',
              open ? 'scale-x-0 opacity-0' : 'opacity-100'
            )}
          />
          <span
            className={cn(
              'absolute inset-x-0 block h-[1.5px] origin-center rounded-full bg-current transition-all duration-300',
              open ? 'top-[7px] -rotate-45' : 'top-[11px]'
            )}
          />
        </div>
      </Button>
      {typeof document === 'undefined'
        ? null
        : createPortal(overlay, document.body)}
    </>
  )
}
