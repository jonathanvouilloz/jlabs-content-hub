import {
  DialogRoot,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogBackdrop,
  DialogTitle,
  Input,
  Button,
  Text,
} from '@chakra-ui/react'
import { useState } from 'react'
import { useHub } from '../context/HubContext'

export default function PatModal() {
  const { pat, setPat, error } = useHub()
  const [value, setValue] = useState('')
  const [loading, setLoading] = useState(false)

  const isOpen = !pat

  const handleSubmit = async () => {
    if (!value.trim()) return
    setLoading(true)
    try {
      await setPat(value.trim())
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleSubmit()
  }

  return (
    <DialogRoot open={isOpen} onOpenChange={() => {}} placement="center" closeOnInteractOutside={false}>
      <DialogBackdrop />
      <DialogContent mx={4}>
        <DialogHeader fontSize="lg" fontWeight="bold">
          <DialogTitle>GitHub Personal Access Token</DialogTitle>
        </DialogHeader>
        <DialogBody pb={6}>
          <Text fontSize="sm" color="gray.600" mb={4}>
            Creez un token avec le scope <strong>repo</strong> sur{' '}
            <Text
              as="a"
              href="https://github.com/settings/tokens"
              target="_blank"
              color="blue.500"
              textDecoration="underline"
            >
              github.com/settings/tokens
            </Text>{' '}
            puis collez-le ci-dessous.
          </Text>

          <Input
            type="password"
            placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            mb={3}
            size="md"
          />

          {error && (
            <Text fontSize="sm" color="red.500" mb={3}>
              {error}
            </Text>
          )}

          <Button
            colorPalette="blue"
            width="100%"
            onClick={handleSubmit}
            loading={loading}
            disabled={!value.trim()}
          >
            Connecter
          </Button>
        </DialogBody>
      </DialogContent>
    </DialogRoot>
  )
}
