import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the database connection module
const mockDbInstance = {
  unsafe: vi.fn(),
  end: vi.fn(),
  begin: vi.fn(async (_mode: string, operation: Function) => operation(mockDbInstance)),
}

vi.mock('../../../src/database/connection', () => ({
  getDb: vi.fn(() => mockDbInstance),
}))

// Now import the modules
import { withDatabase, withReadOnlyDatabase } from '../../../src/database/utils'

describe('Database Utils', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('withDatabase', () => {
    it('should execute database operation successfully', async () => {
      const mockOperation = vi.fn().mockResolvedValue('success')
      const result = await withDatabase('test-url', mockOperation)
      
      expect(result).toBe('success')
      expect(mockOperation).toHaveBeenCalledWith(mockDbInstance)
    })

    it('should handle database operation errors', async () => {
      const mockOperation = vi.fn().mockRejectedValue(new Error('Operation failed'))
      
      await expect(withDatabase('test-url', mockOperation)).rejects.toThrow('Operation failed')
      expect(mockOperation).toHaveBeenCalledWith(mockDbInstance)
    })

    it('should log successful operations', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const mockOperation = vi.fn().mockResolvedValue('success')
      
      await withDatabase('test-url', mockOperation)
      
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Database operation completed successfully in \d+ms/)
      )
      consoleSpy.mockRestore()
    })

    it('should never log raw database operation errors', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const mockOperation = vi.fn().mockRejectedValue(Object.assign(new Error('secret-message'), {
        detail: 'secret-detail',
        query: 'SELECT secret',
        parameters: ['secret-parameter'],
      }))
      
      await expect(withDatabase('test-url', mockOperation)).rejects.toThrow('secret-message')
      
      expect(consoleSpy).not.toHaveBeenCalled()
      consoleSpy.mockRestore()
    })

    it('should measure execution time', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const mockOperation = vi.fn().mockImplementation(async () => {
        // Simulate some delay
        await new Promise(resolve => setTimeout(resolve, 10))
        return 'success'
      })
      
      await withDatabase('test-url', mockOperation)
      
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Database operation completed successfully in \d+ms/)
      )
      consoleSpy.mockRestore()
    })
  })

  describe('withReadOnlyDatabase', () => {
    it('requires a dedicated URL and opens a PostgreSQL read-only transaction', async () => {
      const operation = vi.fn().mockResolvedValue('read result')

      await expect(withReadOnlyDatabase('', operation)).rejects.toThrow('READ_ONLY_DATABASE_URL is required')
      await expect(withReadOnlyDatabase('readonly-url', operation)).resolves.toBe('read result')
      expect(mockDbInstance.begin).toHaveBeenCalledWith('read only', expect.any(Function))
      expect(operation).toHaveBeenCalledWith(mockDbInstance)
    })
  })
})
