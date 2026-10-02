// The element icons the navigator and palette draw beside a tag, filled on a
// 16px grid, and the table from tag name to icon (Icons.tsx).

import type { ReactElement } from 'react';
import { type IconProps, I } from './IconBase';
import {
  elementComponentIconPath1,
  elementSlotIconPath1,
  customElementIconPath1,
  elementDivIconPath1,
  elementImageIconPath1,
  elementImageIconPath2,
  elementSectionIconPath1,
  elementListDefaultIconPath1,
  elementListDefaultIconPath2,
  elementListDefaultIconPath3,
  elementListItemIconPath1,
  elementListItemIconPath2,
  elementListItemIconPath3,
  elementLinkIconPath1,
  elementHeading1IconPath1,
  elementHeading2IconPath1,
  elementHeading3IconPath1,
  elementHeading4IconPath1,
  elementHeading5IconPath1,
  elementHeading6IconPath1,
  elementParagraphIconPath1,
  elementVideoIconPath1,
  elementFormBlockIconPath1,
  elementInputIconPath1,
  elementSelectIconPath1,
  elementSelectIconPath2,
  elementButtonIconPath1,
  homeIconPath1,
} from './iconPaths';

export const ElementComponentIcon = (props: IconProps) => (
  <I {...props} filled>
    <path fillRule="evenodd" clipRule="evenodd" d={elementComponentIconPath1} />
  </I>
);

export const ElementSlotIcon = (props: IconProps) => (
  <I {...props} filled>
    <path fillRule="evenodd" clipRule="evenodd" d={elementSlotIconPath1} />
  </I>
);

// --- Webflow-style element icons (filled, 16px grid) -----------------------

export const CustomElementIcon = (props: IconProps) => (
  <I {...props} filled>
    <path d="M5.35353 11.3536L11.3535 5.35359L10.6464 4.64648L4.64642 10.6465L5.35353 11.3536Z" />
    <path fillRule="evenodd" clipRule="evenodd" d={customElementIconPath1} />
  </I>
);

export const ElementDivIcon = (props: IconProps) => (
  <I {...props} filled>
    <path fillRule="evenodd" clipRule="evenodd" d={elementDivIconPath1} />
  </I>
);

export const ElementImageIcon = (props: IconProps) => (
  <I {...props} filled>
    <path d={elementImageIconPath1} />
    <path fillRule="evenodd" clipRule="evenodd" d={elementImageIconPath2} />
  </I>
);

export const ElementSectionIcon = (props: IconProps) => (
  <I {...props} filled>
    <path fillRule="evenodd" clipRule="evenodd" d={elementSectionIconPath1} />
  </I>
);

export const ElementListDefaultIcon = (props: IconProps) => (
  <I {...props} filled>
    <path d={elementListDefaultIconPath1} />
    <path d="M6 4H14V3H6V4Z" />
    <path d="M6 8H14V7H6V8Z" />
    <path d="M6 12H14V11H6V12Z" />
    <path d={elementListDefaultIconPath2} />
    <path d={elementListDefaultIconPath3} />
  </I>
);

export const ElementListItemIcon = (props: IconProps) => (
  <I {...props} filled>
    <g opacity="0.4">
      <path d={elementListItemIconPath1} />
      <path d="M14 12H6V11H14V12Z" />
    </g>
    <path d={elementListItemIconPath2} />
    <path d="M14 8H6V7H14V8Z" />
    <g opacity="0.4">
      <path d={elementListItemIconPath3} />
      <path d="M14 4H6V3H14V4Z" />
    </g>
  </I>
);

export const ElementLinkIcon = (props: IconProps) => (
  <I {...props} filled>
    <path fillRule="evenodd" clipRule="evenodd" d={elementLinkIconPath1} />
  </I>
);

export const ElementHeading1Icon = (props: IconProps) => (
  <I {...props} filled>
    <path d="M3 12V4H4V8H7V4H8V12H7V9H4V12H3Z" />
    <path d={elementHeading1IconPath1} />
  </I>
);

export const ElementHeading2Icon = (props: IconProps) => (
  <I {...props} filled>
    <path d="M3 4V12H4V9H7V12H8V4H7V8H4V4H3Z" />
    <path d={elementHeading2IconPath1} />
  </I>
);

export const ElementHeading3Icon = (props: IconProps) => (
  <I {...props} filled>
    <path d="M3 12V4H4V8H7V4H8V12H7V9H4V12H3Z" />
    <path d={elementHeading3IconPath1} />
  </I>
);

export const ElementHeading4Icon = (props: IconProps) => (
  <I {...props} filled>
    <path d="M3 4V12H4V9H7V12H8V4H7V8H4V4H3Z" />
    <path d={elementHeading4IconPath1} />
  </I>
);

export const ElementHeading5Icon = (props: IconProps) => (
  <I {...props} filled>
    <path d="M3 4V12H4V9H7V12H8V4H7V8H4V4H3Z" />
    <path d={elementHeading5IconPath1} />
  </I>
);

export const ElementHeading6Icon = (props: IconProps) => (
  <I {...props} filled>
    <path d="M3 12V4H4V8H7V4H8V12H7V9H4V12H3Z" />
    <path fillRule="evenodd" clipRule="evenodd" d={elementHeading6IconPath1} />
  </I>
);

export const ElementParagraphIcon = (props: IconProps) => (
  <I {...props} filled>
    <path fillRule="evenodd" clipRule="evenodd" d={elementParagraphIconPath1} />
  </I>
);

export const ElementVideoIcon = (props: IconProps) => (
  <I {...props} filled>
    <path fillRule="evenodd" clipRule="evenodd" d={elementVideoIconPath1} />
  </I>
);

export const ElementFormBlockIcon = (props: IconProps) => (
  <I {...props} filled>
    <path d="M14 5H2V4H14V5Z" />
    <path d="M14 8H2V7H14V8Z" />
    <path d={elementFormBlockIconPath1} />
  </I>
);

export const ElementInputIcon = (props: IconProps) => (
  <I {...props} filled>
    <path fillRule="evenodd" clipRule="evenodd" d={elementInputIconPath1} />
    <path opacity="0.6" fillRule="evenodd" clipRule="evenodd" d="M4 11V5H5V11H4Z" />
  </I>
);

export const ElementSelectIcon = (props: IconProps) => (
  <I {...props} filled>
    <path d={elementSelectIconPath1} />
    <path fillRule="evenodd" clipRule="evenodd" d={elementSelectIconPath2} />
  </I>
);

export const ElementButtonIcon = (props: IconProps) => (
  <I {...props} filled>
    <path d={elementButtonIconPath1} />
  </I>
);

// Tag-specific element icons; anything without a dedicated icon gets the
// generic custom-element box.
export const HomeIcon = (props: IconProps) => (
  <I {...props} filled>
    <path fillRule="evenodd" clipRule="evenodd" d={homeIconPath1} />
  </I>
);

export const TAG_ICONS: Readonly<Record<string, (props: IconProps) => ReactElement>> = {
  div: ElementDivIcon,
  nav: HomeIcon,
  img: ElementImageIcon,
  section: ElementSectionIcon,
  ul: ElementListDefaultIcon,
  ol: ElementListDefaultIcon,
  li: ElementListItemIcon,
  a: ElementLinkIcon,
  h1: ElementHeading1Icon,
  h2: ElementHeading2Icon,
  h3: ElementHeading3Icon,
  h4: ElementHeading4Icon,
  h5: ElementHeading5Icon,
  h6: ElementHeading6Icon,
  p: ElementParagraphIcon,
  video: ElementVideoIcon,
  form: ElementFormBlockIcon,
  input: ElementInputIcon,
  textarea: ElementInputIcon,
  select: ElementSelectIcon,
  button: ElementButtonIcon,
  slot: ElementSlotIcon,
};

export function elementIcon(tag: unknown, size = 12, className?: string) {
  const Icon = TAG_ICONS[String(tag).toLowerCase()] || CustomElementIcon;
  return <Icon size={size} className={className} />;
}
