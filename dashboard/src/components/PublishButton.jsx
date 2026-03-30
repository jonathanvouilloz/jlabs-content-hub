import { Button, Box } from '@chakra-ui/react'
import { useState } from 'react'
import { useHub } from '../context/HubContext'

export default function PublishButton({ item }) {
  const { togglePublished } = useHub()
  const [loading, setLoading] = useState(false)

  const isPublished = !item.isDraft

  const handleClick = async (e) => {
    e.stopPropagation()
    setLoading(true)
    try {
      await togglePublished(item)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button
      size="xs"
      variant="ghost"
      onClick={handleClick}
      loading={loading}
      color={isPublished ? 'green.600' : 'gray.500'}
      _hover={{ bg: isPublished ? 'green.50' : 'gray.100' }}
    >
      <Box
        as="span"
        w="8px"
        h="8px"
        borderRadius="full"
        bg={isPublished ? 'green.400' : 'gray.400'}
        mr={1.5}
        display="inline-block"
      />
      {isPublished ? 'Publie' : 'Non publie'}
    </Button>
  )
}
