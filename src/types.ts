export type CanonicalPrimitive = null | boolean | number | string;

export type CanonicalObject = { readonly [key: string]: CanonicalValue };

export type CanonicalValue =
  | CanonicalPrimitive
  | readonly CanonicalValue[]
  | CanonicalObject;
