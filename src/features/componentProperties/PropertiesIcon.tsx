import type { IconProps } from '../../ui/Icons';

export function PropertiesIcon({ size = 24 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path fill="currentColor" d={OUTER_RING} />
      <path fill="currentColor" d={BINDING} />
      <path opacity="0.4" fill="currentColor" d={INNER_RING} />
    </svg>
  );
}
const OUTER_RING =
  'M12 2C16.4776 2 20.2677 4.94292 21.542 9H20.4863' +
  'C19.2507 5.50468 15.9185 3 12 3C7.02944 3 3 7.02944 3 12' +
  'C3 16.9706 7.02944 21 12 21C15.9185 21 19.2507 18.4953 20.4863 15H21.542' +
  'C20.2677 19.0571 16.4776 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2Z';
const BINDING =
  'M12 10C12.9317 10 13.7123 10.6377 13.9346 11.5H22V12.5H13.9346' +
  'C13.7123 13.3623 12.9317 14 12 14C10.8954 14 10 13.1046 10 12C10 10.8954 10.8954 10 12 10Z';
const INNER_RING =
  'M12 6C14.2205 6 16.1578 7.20707 17.1953 9H16' +
  'C15.0878 7.78565 13.6357 7 12 7C9.23858 7 7 9.23858 7 12C7 14.7614 9.23858 17 12 17' +
  'C13.6357 17 15.0878 16.2143 16 15H17.1953C16.1578 16.7929 14.2205 18 12 18' +
  'C8.68629 18 6 15.3137 6 12C6 8.68629 8.68629 6 12 6Z';
