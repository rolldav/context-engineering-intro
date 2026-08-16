import { describe, it, expect } from 'vitest'
import { validateReadOnlySqlQuery, validateSqlQuery, isWriteOperation } from '../../../src/database/security'
import {
  validSelectQuery,
  validInsertQuery,
  validUpdateQuery,
  validDeleteQuery,
  dangerousDropQuery,
  dangerousDeleteAllQuery,
  maliciousInjectionQuery,
  emptyQuery,
  whitespaceQuery,
} from '../../fixtures/database.fixtures'

describe('Database Security', () => {
  describe('validateSqlQuery', () => {
    it('should validate safe SELECT queries', () => {
      const result = validateSqlQuery(validSelectQuery)
      expect(result.isValid).toBe(true)
      expect(result.error).toBeUndefined()
    })

    it('should validate safe INSERT queries', () => {
      const result = validateSqlQuery(validInsertQuery)
      expect(result.isValid).toBe(true)
      expect(result.error).toBeUndefined()
    })

    it('should reject empty queries', () => {
      const result = validateSqlQuery(emptyQuery)
      expect(result.isValid).toBe(false)
      expect(result.error).toBe('SQL query cannot be empty')
    })

    it('should reject whitespace-only queries', () => {
      const result = validateSqlQuery(whitespaceQuery)
      expect(result.isValid).toBe(false)
      expect(result.error).toBe('SQL query cannot be empty')
    })

    it('should allow a single privileged DROP statement for the separately authorized write tool', () => {
      const result = validateSqlQuery(dangerousDropQuery)
      expect(result.isValid).toBe(true)
      expect(isWriteOperation(dangerousDropQuery)).toBe(true)
    })

    it('should reject dangerous DELETE ALL queries', () => {
      const result = validateSqlQuery(dangerousDeleteAllQuery)
      expect(result.isValid).toBe(false)
      expect(result.error).toBe('Only one SQL statement is allowed')
    })

    it('should reject SQL injection attempts', () => {
      const result = validateSqlQuery(maliciousInjectionQuery)
      expect(result.isValid).toBe(false)
      expect(result.error).toBe('Only one SQL statement is allowed')
    })

    it('should handle case-insensitive dangerous patterns', () => {
      const upperCaseQuery = 'SELECT * FROM users; DROP TABLE users;'
      const result = validateSqlQuery(upperCaseQuery)
      expect(result.isValid).toBe(false)
      expect(result.error).toBe('Only one SQL statement is allowed')
    })
  })

  describe('isWriteOperation', () => {
    it('should identify SELECT as read operation', () => {
      expect(isWriteOperation(validSelectQuery)).toBe(false)
    })

    it('should identify INSERT as write operation', () => {
      expect(isWriteOperation(validInsertQuery)).toBe(true)
    })

    it('should identify UPDATE as write operation', () => {
      expect(isWriteOperation(validUpdateQuery)).toBe(true)
    })

    it('should identify DELETE as write operation', () => {
      expect(isWriteOperation(validDeleteQuery)).toBe(true)
    })

    it('should identify DROP as write operation', () => {
      expect(isWriteOperation(dangerousDropQuery)).toBe(true)
    })

    it('should handle case-insensitive operations', () => {
      expect(isWriteOperation('insert into users values (1, \'test\')')).toBe(true)
      expect(isWriteOperation('UPDATE users SET name = \'test\'')).toBe(true)
      expect(isWriteOperation('Delete from users where id = 1')).toBe(true)
    })

    it('should handle queries with leading whitespace', () => {
      expect(isWriteOperation('   INSERT INTO users VALUES (1, \'test\')')).toBe(true)
      expect(isWriteOperation('\t\nSELECT * FROM users')).toBe(false)
    })
  })

  describe('validateReadOnlySqlQuery', () => {
    it.each([
      'WITH changed AS (DELETE FROM users RETURNING *) SELECT * FROM changed',
      'WITH changed AS (UPDATE users SET name = \'x\' RETURNING *) SELECT * FROM changed',
      'WITH changed AS (INSERT INTO users(name) VALUES (\'x\') RETURNING *) SELECT * FROM changed',
      'WITH source AS (SELECT 1) DELETE FROM users USING source',
      'EXPLAIN ANALYZE DELETE FROM users',
      'SELECT * FROM users; DELETE FROM users',
      'SELECT * FROM users /* harmless */; -- hidden\n UPDATE users SET name = \'x\'',
      'SELECT nextval(\'users_id_seq\')',
    ])('rejects write or side-effect bypass: %s', (sql) => {
      expect(validateReadOnlySqlQuery(sql).isValid).toBe(false)
      expect(isWriteOperation(sql)).toBe(true)
    })

    it.each([
      'SELECT * FROM users',
      'SELECT \'; not a statement\' AS value',
      'WITH visible AS (SELECT id FROM users) SELECT * FROM visible',
      'WITH values_cte AS (VALUES (1), (2)) SELECT * FROM values_cte;',
    ])('accepts one read-only statement: %s', (sql) => {
      expect(validateReadOnlySqlQuery(sql)).toEqual({ isValid: true })
      expect(isWriteOperation(sql)).toBe(false)
    })
  })

})
