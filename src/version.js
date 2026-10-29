/**
 * Version du produit, annoncée par les **trois** CLI (`--version`).
 *
 * Une seule constante, et non trois littéraux : `xdm-media --version` répondait « option
 * inconnue » pendant que les deux autres répondaient en code 0 (`D-082`). Le numéro reste
 * celui de `package.json` ; ce module existe pour qu'il n'y ait qu'un endroit à corriger.
 *
 * @module version
 */

/** Version annoncée par `--version`. */
export const VERSION = '0.1.0';
