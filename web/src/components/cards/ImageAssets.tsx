import { SimpleGrid } from '@mantine/core';
import { assetUrl } from '../../api';
import type { Card } from '../../types';

// Image grid for non-draft image cards (the editable-draft template renders its own images with
// per-asset Copy buttons — see EditableDraft).
export function ImageAssets({ card }: { card: Card }) {
  if (!card.assets?.length) return null;
  return (
    <SimpleGrid cols={{ base: 1, sm: card.assets.length > 1 ? 2 : 1 }} spacing="sm">
      {card.assets.map((a) => (
        <img
          key={a.id}
          className="relay-asset-img"
          loading="lazy"
          alt={card.title}
          src={assetUrl(card.id, a.id)}
        />
      ))}
    </SimpleGrid>
  );
}
