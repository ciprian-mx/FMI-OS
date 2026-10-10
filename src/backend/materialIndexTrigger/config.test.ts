import { ConfigError, loadConfig } from './config';
import { DEFAULT_INDEXER_CONFIG } from './indexMaterial';

/**
 * Task 4.6 — materialIndexTrigger environment configuration.
 *
 * Validates: Requirements 7.6
 */

const VALID_ENV = {
  KNOWLEDGE_BASE_ID: 'KB12345678',
  DATA_SOURCE_ID: 'DS12345678',
  API_FMIOS_MATERIALFILETABLE_NAME: 'MaterialFile-abc123-dev',
};

describe('loadConfig', () => {
  it('reads the Knowledge Base, data source and MaterialFile table', () => {
    expect(loadConfig(VALID_ENV)).toEqual({
      knowledgeBaseId: 'KB12345678',
      dataSourceId: 'DS12345678',
      materialFileTableName: 'MaterialFile-abc123-dev',
      materialFileStudentIndex: 'byStudent',
      indexer: DEFAULT_INDEXER_CONFIG,
    });
  });

  it('reports every missing or invalid variable at once', () => {
    let thrown: unknown;
    try {
      loadConfig({ KNOWLEDGE_BASE_ID: 'not-a-bedrock-id', DATA_SOURCE_ID: '' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).problems).toEqual([
      'KNOWLEDGE_BASE_ID must be a 10-character alphanumeric Bedrock id',
      'DATA_SOURCE_ID is not set',
      'API_FMIOS_MATERIALFILETABLE_NAME is not set',
    ]);
  });
});
