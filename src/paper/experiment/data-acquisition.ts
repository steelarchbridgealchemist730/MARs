import type { DataRequirement } from './types'

interface DataSource {
  description: string
  access: 'free' | 'free_with_key' | 'institutional'
  auto_downloadable: boolean
  instructions?: string
  download_cmd?: string
  api_key_env?: string
}

const DATA_SOURCE_REGISTRY: Record<string, DataSource> = {
  // Financial data
  yahoo_finance: {
    description: 'Yahoo Finance historical prices',
    access: 'free',
    auto_downloadable: true,
    download_cmd:
      "pip install yfinance && python -c \"import yfinance as yf; data = yf.download('SPY', period='max'); data.to_csv('data.csv')\"",
  },
  fred: {
    description: 'Federal Reserve Economic Data',
    access: 'free_with_key',
    auto_downloadable: true,
    api_key_env: 'FRED_API_KEY',
    instructions:
      'Get a free API key at https://fred.stlouisfed.org/docs/api/api_key.html',
  },
  wrds_taq: {
    description: 'WRDS TAQ High-Frequency Trade Data',
    access: 'institutional',
    auto_downloadable: false,
    instructions:
      'Requires WRDS account. Apply at https://wrds-www.wharton.upenn.edu/',
  },
  // ML datasets
  huggingface: {
    description: 'Hugging Face Datasets Hub',
    access: 'free',
    auto_downloadable: true,
    download_cmd: 'pip install datasets',
  },
  kaggle: {
    description: 'Kaggle Datasets',
    access: 'free_with_key',
    auto_downloadable: true,
    api_key_env: 'KAGGLE_KEY',
    instructions:
      'Set KAGGLE_KEY env var. Get credentials from https://www.kaggle.com/settings',
  },
  // General
  uci_ml: {
    description: 'UCI Machine Learning Repository',
    access: 'free',
    auto_downloadable: true,
    download_cmd: 'pip install ucimlrepo',
  },
  openml: {
    description: 'OpenML datasets',
    access: 'free',
    auto_downloadable: true,
    download_cmd: 'pip install openml',
  },
}

export interface DataAcquisitionResult {
  status: 'ready_to_download' | 'waiting_for_user' | 'manual_required'
  instruction_shown?: boolean
  download_cmd?: string
  message?: string
}

export class DataAcquisition {
  async acquireDataset(
    requirement: DataRequirement,
  ): Promise<DataAcquisitionResult> {
    const source = DATA_SOURCE_REGISTRY[requirement.source]

    if (!source) {
      // Unknown source — try direct URL if available
      return {
        status: 'manual_required',
        message: `Unknown data source "${requirement.source}". Please provide the dataset manually.`,
      }
    }

    if (source.auto_downloadable) {
      // Check API key if required
      if (source.api_key_env && !process.env[source.api_key_env]) {
        return {
          status: 'waiting_for_user',
          instruction_shown: true,
          message: `Dataset "${source.description}" requires ${source.api_key_env} env var. ${source.instructions ?? ''}`,
        }
      }

      return {
        status: 'ready_to_download',
        download_cmd: source.download_cmd,
        message: `Dataset "${source.description}" is auto-downloadable. Run the download command to acquire it.`,
      }
    }

    if (source.access === 'institutional') {
      return {
        status: 'waiting_for_user',
        instruction_shown: true,
        message: [
          `Dataset: ${source.description}`,
          `This dataset requires institutional access.`,
          source.instructions ?? '',
          `Once downloaded, place files in the experiments/data/ directory.`,
        ].join('\n'),
      }
    }

    return { status: 'manual_required' }
  }

  getKnownSources(): Array<{ id: string } & DataSource> {
    return Object.entries(DATA_SOURCE_REGISTRY).map(([id, source]) => ({
      id,
      ...source,
    }))
  }

  isKnownSource(sourceId: string): boolean {
    return sourceId in DATA_SOURCE_REGISTRY
  }
}
