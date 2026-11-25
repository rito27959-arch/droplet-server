/**
 * Un numéro camerounais réduit à ses neuf chiffres locaux (6XXXXXXXX).
 * On accepte en entrée +237, 237, des espaces ou des tirets.
 */
export function numeroLocal(v) {
  let net = String(v || '').replace(/\D/g, '');
  if (net.length === 12 && net.startsWith('237')) net = net.slice(3);
  return /^6\d{8}$/.test(net) ? net : null;
}

/** Pour l'affichage et les journaux : jamais le numéro entier. */
export function masquer(local) {
  return `${local.slice(0, 2)}•••••${local.slice(-2)}`;
}
