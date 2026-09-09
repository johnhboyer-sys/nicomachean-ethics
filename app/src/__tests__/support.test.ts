// The single source of truth for the donation link. It is interpolated into an
// `<a href>` on the home page, every work landing and every reading page's
// header, all with target="_blank", so the contract is narrow but load-bearing:
// one absolute https Stripe URL, no interpolation, no trailing junk.
import { describe, expect, it } from 'vitest';
import { SUPPORT_URL } from '../lib/support';

describe('SUPPORT_URL', () => {
  it('is an absolute https URL', () => {
    expect(SUPPORT_URL.startsWith('https://')).toBe(true);
    expect(() => new URL(SUPPORT_URL)).not.toThrow();
  });

  // A Stripe Payment Link, deliberately: a plain hosted-checkout URL, so the
  // on-site card and header pill stay in our own tokens until the click.
  it('points at Stripe checkout, not at some other host', () => {
    expect(new URL(SUPPORT_URL).hostname).toBe('buy.stripe.com');
  });

  // The href goes into markup verbatim. A stray space, newline or quote would
  // either break the attribute or send the reader to a 404 payment page.
  it('is safe to interpolate straight into an href', () => {
    expect(SUPPORT_URL).toBe(SUPPORT_URL.trim());
    expect(SUPPORT_URL).not.toMatch(/[\s"'<>]/);
    expect(SUPPORT_URL).not.toMatch(/[?&]$/);
  });

  it('carries a payment-link path, not a bare host', () => {
    expect(new URL(SUPPORT_URL).pathname).toMatch(/^\/\w+/);
  });
});
