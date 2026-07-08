import { Anchor, Group, Image } from '@mantine/core';
import { responseAssetUrl } from '../../api';
import type { Card } from '../../types';

// Renders the files the USER attached to their reply, back on the resolved card, so it's clear what
// was sent up to the agent. Images show as thumbnails; other files as a tappable filename link.
// Distinct from ImageAssets, which renders images the AGENT sent down on the card itself.
export function ReplyAssets({ card }: { card: Card }) {
  if (!card.response_assets?.length) return null;
  return (
    <Group gap="xs" mt="xs" wrap="wrap">
      {card.response_assets.map((a) =>
        a.mime.startsWith('image/') ? (
          <Anchor key={a.id} href={responseAssetUrl(card.id, a.id)} target="_blank" rel="noreferrer">
            <Image src={responseAssetUrl(card.id, a.id)} alt={a.filename} h={72} w={72} fit="cover" radius="sm" />
          </Anchor>
        ) : (
          <Anchor key={a.id} href={responseAssetUrl(card.id, a.id)} target="_blank" rel="noreferrer" size="xs">
            📎 {a.filename}
          </Anchor>
        ),
      )}
    </Group>
  );
}
