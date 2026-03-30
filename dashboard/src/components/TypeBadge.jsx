import { Badge } from '@chakra-ui/react'

export default function TypeBadge({ type }) {
  const config = {
    article: { colorPalette: 'blue', label: 'ARTICLE' },
    gmb: { colorPalette: 'red', label: 'GMB' },
    linkedin: {
      color: '#0a66c2',
      bg: 'rgba(10,102,194,0.08)',
      label: 'LINKEDIN',
    },
  }
  const c = config[type] || config.article
  return (
    <Badge
      colorPalette={c.colorPalette}
      bg={c.bg}
      color={c.color}
      fontSize="10px"
      letterSpacing="0.5px"
    >
      {c.label}
    </Badge>
  )
}
