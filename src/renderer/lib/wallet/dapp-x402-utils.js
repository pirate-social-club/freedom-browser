import { getPermissionKey } from '../origin-utils.js';

export function normalizeX402BannerOrigin(origin) {
  return getPermissionKey(origin) || origin || null;
}

export function shouldShowChooserForSelection(fundableCount, selectedFundable) {
  return fundableCount >= 2 || !selectedFundable;
}

export function selectedAcceptChanged(prevAccepts, nextAccepts, selectedIndex) {
  const prevSelected = prevAccepts?.[selectedIndex];
  const nextSelected = nextAccepts?.[selectedIndex];
  return !!(prevSelected && nextSelected && (
    prevSelected.balance !== nextSelected.balance ||
    prevSelected.fundable !== nextSelected.fundable
  ));
}
