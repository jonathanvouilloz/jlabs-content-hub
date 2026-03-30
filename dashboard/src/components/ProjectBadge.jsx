import { Badge } from '@chakra-ui/react'

export default function ProjectBadge({ project }) {
  return (
    <Badge bg="rgba(124,58,237,0.08)" color="#7c3aed" fontSize="11px">
      {project}
    </Badge>
  )
}
