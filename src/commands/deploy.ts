import fs from 'node:fs'
import { Readable } from 'node:stream'

import { ANT, AOProcess, ARIO } from '@ar.io/sdk'
import {
  ARIOToTokenAmount,
  ETHToTokenAmount,
  OnDemandFunding,
  TurboFactory,
} from '@ardrive/turbo-sdk'
import { Command } from '@oclif/core'
import { connect } from '@permaweb/aoconnect'
import boxen from 'boxen'
import chalk from 'chalk'
import Table from 'cli-table3'
import ora from 'ora'

import { type DeployConfig, deployFlagConfigs } from '../constants/flags.js'
import { promptAdvancedOptions } from '../prompts/arns.js'
import { getWalletConfig } from '../prompts/wallet.js'
import type { ArnsRecord, SignerType } from '../types/index.js'
import { extractFlags, resolveConfig } from '../utils/config-resolver.js'
import { expandPath } from '../utils/path.js'
import { createSigner } from '../utils/signer.js'
import { uploadFile, uploadFolder } from '../utils/uploader.js'
import {
  resolveArioProcess,
  validateArioProcess,
  validateTtl,
  validateUndername,
} from '../utils/validators.js'

export default class Deploy extends Command {
  static override args = {}

  static override description = 'Deploy your application to the permaweb'

  static override examples = [
    '<%= config.bin %> deploy  # Interactive mode',
    '<%= config.bin %> deploy --arns-name my-app --wallet ./wallet.json',
    '<%= config.bin %> deploy --arns-name my-app --private-key "$(cat wallet.json)"',
    '<%= config.bin %> deploy --arns-name my-app --undername staging',
    '<%= config.bin %> deploy --arns-name my-app --deploy-file ./dist/index.html',
    '<%= config.bin %> deploy --arns-name my-app --sig-type ethereum --wallet ./private-key.txt',
    '<%= config.bin %> deploy --arns-name my-app --sig-type ethereum --private-key "0x..."',
    '<%= config.bin %> deploy --arns-name my-app --on-demand ario --max-token-amount 1000',
  ]

  static override flags = extractFlags(deployFlagConfigs)

  public async run(): Promise<void> {
    try {
      const { flags } = await this.parse(Deploy)

      if (flags.anchor) {
        const allowedLong = new Set(['--anchor', '--preview-id', '--wallet'])
        const allowedShort = new Set(['-w'])
        const disallowed: string[] = []

        for (const arg of this.argv) {
          if (!arg.startsWith('-')) {
            continue
          }

          if (arg.startsWith('--')) {
            const name = arg.split('=')[0]
            if (!allowedLong.has(name)) {
              disallowed.push(name)
            }
            continue
          }

          if (!allowedShort.has(arg)) {
            disallowed.push(arg)
          }
        }

        if (disallowed.length > 0) {
          this.error(
            `--anchor only allows --preview-id and --wallet (found ${disallowed.join(', ')})`,
          )
        }
      }

      if (flags.preview) {
        const allowedLong = new Set(['--preview', '--deploy-folder', '--deploy-file', '--wallet'])
        const allowedShort = new Set(['-d', '-f', '-w'])
        const disallowed: string[] = []

        for (const arg of this.argv) {
          if (!arg.startsWith('-')) {
            continue
          }

          if (arg.startsWith('--')) {
            const name = arg.split('=')[0]
            if (!allowedLong.has(name)) {
              disallowed.push(name)
            }
            continue
          }

          if (!allowedShort.has(arg)) {
            disallowed.push(arg)
          }
        }

        if (disallowed.length > 0) {
          this.error(
            `--preview only allows --deploy-folder/--deploy-file and --wallet (found ${disallowed.join(', ')})`,
          )
        }
      }

      const interactive = !flags.preview && !flags.anchor && !flags['arns-name']

      if (interactive) {
        this.log(chalk.cyan.bold('\n🎯 Interactive Deployment Mode\n'))
      }

      // Resolve base configuration - prompts will run automatically in interactive mode
      const baseConfig = (await resolveConfig<typeof deployFlagConfigs>(deployFlagConfigs, flags, {
        interactive,
      })) as DeployConfig

      // Handle wallet configuration (shared between wallet and privateKey)
      let walletConfig: { privateKey?: string; wallet?: string } = {
        privateKey: baseConfig['private-key'],
        wallet: baseConfig.wallet,
      }

      if (interactive && !baseConfig.wallet && !baseConfig['private-key']) {
        const config = await getWalletConfig()
        walletConfig = {
          privateKey: config.privateKey,
          wallet: config.wallet,
        }
      }

      // Handle advanced options (shared between ttlSeconds, undername, arioProcess, onDemand, maxTokenAmount)
      let advancedOptions:
        | {
            arioProcess: string
            maxTokenAmount?: string
            onDemand?: string
            ttlSeconds: string
            undername: string
          }
        | undefined

      if (interactive) {
        const options = await promptAdvancedOptions()
        advancedOptions = options || undefined
      }

      // Build final config with shared prompt results
      const deployConfig: DeployConfig = {
        'ario-process': advancedOptions?.arioProcess || baseConfig['ario-process'],
        'arns-name': baseConfig['arns-name'],
        'deploy-file': baseConfig['deploy-file'],
        'deploy-folder': baseConfig['deploy-folder'],
        'max-token-amount': advancedOptions?.maxTokenAmount || baseConfig['max-token-amount'],
        'on-demand': advancedOptions?.onDemand || baseConfig['on-demand'],
        'private-key': walletConfig.privateKey,
        preview: baseConfig.preview,
        anchor: baseConfig.anchor,
        'preview-id': baseConfig['preview-id'],
        'sig-type': baseConfig['sig-type'],
        'ttl-seconds': advancedOptions?.ttlSeconds || baseConfig['ttl-seconds'],
        undername: advancedOptions?.undername || baseConfig.undername,
        wallet: walletConfig.wallet,
      }

      if (interactive) {
        this.log('')
      }

      // Get deploy key from wallet file, private-key flag, or environment variable
      let deployKey: string
      if (deployConfig.wallet) {
        const walletPath = expandPath(deployConfig.wallet)
        if (!fs.existsSync(walletPath)) {
          this.error(`Wallet file [${deployConfig.wallet}] does not exist`)
        }

        const walletContent = fs.readFileSync(walletPath, 'utf8')
        // For Arweave wallets (JWK), encode to base64. For others (private keys), use as-is
        deployKey =
          deployConfig['sig-type'] === 'arweave'
            ? Buffer.from(walletContent).toString('base64')
            : walletContent.trim()
      } else if (deployConfig['private-key']) {
        // For Arweave wallets (JWK JSON), encode to base64. For others, use as-is
        deployKey =
          deployConfig['sig-type'] === 'arweave'
            ? Buffer.from(deployConfig['private-key']).toString('base64')
            : deployConfig['private-key'].trim()
      } else {
        deployKey = process.env.DEPLOY_KEY || ''
        if (!deployKey) {
          this.error(
            'DEPLOY_KEY environment variable not set. Use --wallet, --private-key, or set DEPLOY_KEY',
          )
        }
      }

      if (deployConfig.anchor) {
        if (!deployConfig['preview-id']) {
          this.error('--preview-id is required when using --anchor')
        }

        if (!deployConfig.wallet) {
          this.error('--wallet is required when using --anchor')
        }

        await anchorPreviewManifest({
          previewId: deployConfig['preview-id'],
          deployKey,
        })

        return
      }

      let arioProcess = deployConfig['ario-process']
      const usePreview = Boolean(deployConfig.preview)
      const skipAnt = usePreview

      if (!usePreview) {
        const arioValidation = validateArioProcess(arioProcess)
        if (arioValidation !== true) {
          this.error(arioValidation)
        }

        const ttlValidation = validateTtl(deployConfig['ttl-seconds'])
        if (ttlValidation !== true) {
          this.error(ttlValidation)
        }

        const undernameValidation = validateUndername(deployConfig.undername)
        if (undernameValidation !== true) {
          this.error(undernameValidation)
        }

        arioProcess = resolveArioProcess(arioProcess)
      }

      this.log(chalk.cyan.bold('\n🚀 Starting deployment...\n'))
      try {
        const spinner = ora('Initializing ARIO').start()
        let ario: ARIO | undefined
        let arnsNameRecord: ArnsRecord | undefined

        if (!skipAnt) {
          const ao = connect({
            CU_URL: 'https://cu.ardrive.io',
            MODE: 'legacy',
            MU_URL: 'https://mu.ao-testnet.xyz',
          })

          ario = ARIO.init({
            process: new AOProcess({
              ao,
              processId: arioProcess,
            }),
          })

          spinner.succeed('ARIO initialized')

          // Get ArNS record
          spinner.start(`Fetching ArNS record for ${chalk.yellow(deployConfig['arns-name'])}`)
          const arioClient = ario as unknown as {
            getArNSRecord: (args: { name: string }) => Promise<ArnsRecord>
          }

          arnsNameRecord = await arioClient
            .getArNSRecord({ name: deployConfig['arns-name'] })
            .catch(() => {
              spinner.fail(`ArNS name ${chalk.red(deployConfig['arns-name'])} does not exist`)
              this.error(`ArNS name [${deployConfig['arns-name']}] does not exist`)
            })

          spinner.succeed(`ArNS record fetched for ${chalk.green(deployConfig['arns-name'])}`)
        } else {
          spinner.succeed('Skipping ANT update')
        }

        // Create signer
        spinner.start('Creating signer')
        const { signer, token } = createSigner(deployConfig['sig-type'] as SignerType, deployKey)
        spinner.succeed(`Signer created (${chalk.cyan(deployConfig['sig-type'])})`)

        // Initialize Turbo
        spinner.start('Initializing Turbo')
        const uploadServiceUrl = usePreview
          ? 'https://loaded-turbo-api.load.network'
          : process.env.TURBO_UPLOAD_SERVICE_URL || 'https://upload.ardrive.io'
        const turbo = TurboFactory.authenticated({
          signer,
          token,
          uploadServiceConfig: {
            url: uploadServiceUrl,
          },
        })
        spinner.succeed('Turbo initialized')

        // Create on-demand funding mode if specified
        let fundingMode: OnDemandFunding | undefined
        if (deployConfig['on-demand'] && deployConfig['max-token-amount']) {
          const tokenType = deployConfig['on-demand']
          const maxAmount = Number.parseFloat(deployConfig['max-token-amount'])

          let maxTokenAmount: ReturnType<typeof ARIOToTokenAmount>
          switch (tokenType) {
            case 'ario': {
              maxTokenAmount = ARIOToTokenAmount(maxAmount)
              break
            }

            case 'base-eth': {
              maxTokenAmount = ETHToTokenAmount(maxAmount)
              break
            }

            default: {
              throw new Error(`Unsupported on-demand token type: ${tokenType}`)
            }
          }

          fundingMode = new OnDemandFunding({
            maxTokenAmount,
            topUpBufferMultiplier: 1.1,
          })
        }

        // Upload file or folder
        let txOrManifestId: string
        if (deployConfig['deploy-file']) {
          const filePath = expandPath(deployConfig['deploy-file'])
          spinner.start(`Uploading file ${chalk.yellow(deployConfig['deploy-file'])}`)
          txOrManifestId = await uploadFile(turbo, filePath, { fundingMode })
          spinner.succeed(`File uploaded: ${chalk.green(txOrManifestId)}`)
        } else {
          const folderPath = expandPath(deployConfig['deploy-folder'])
          spinner.start(`Uploading folder ${chalk.yellow(deployConfig['deploy-folder'])}`)
          txOrManifestId = await uploadFolder(turbo, folderPath, { fundingMode })
          spinner.succeed(`Folder uploaded: ${chalk.green(txOrManifestId)}`)
        }

        this.log('')

        if (!skipAnt) {
          // Initialize ANT and update record
          spinner.start('Updating ANT record')
          const ant = ANT.init({ processId: arnsNameRecord?.processId || '', signer })

          await ant.setRecord(
            {
              transactionId: txOrManifestId,
              ttlSeconds: Number.parseInt(deployConfig['ttl-seconds'], 10),
              undername: deployConfig.undername,
            },
            {
              tags: [
                {
                  name: 'App-Name',
                  value: 'Permaweb-Deploy',
                },
                ...(process.env.GITHUB_SHA
                  ? [
                      {
                        name: 'GIT-HASH',
                        value: process.env.GITHUB_SHA,
                      },
                    ]
                  : []),
              ],
            },
          )

          spinner.succeed('ANT record updated')

          // Display deployment details in a table inside a success box
          const table = new Table({
            head: [chalk.cyan.bold('Property'), chalk.cyan.bold('Value')],
            style: {
              head: [],
            },
          })

          table.push(
            ['Tx ID', chalk.green(txOrManifestId)],
            ['ArNS Name', chalk.yellow(deployConfig['arns-name'])],
            ['Undername', chalk.yellow(deployConfig.undername)],
            ['ANT', chalk.cyan(arnsNameRecord?.processId || '')],
            ['ARIO Process', chalk.gray(arioProcess)],
            ['TTL Seconds', chalk.blue(deployConfig['ttl-seconds'])],
          )

          const successMessage = boxen(
            `${chalk.green.bold('✨ Deployment Successful!')}\n\n${table.toString()}`,
            {
              borderColor: 'green',
              borderStyle: 'round',
              padding: 1,
              title: chalk.bold('🚀 Permaweb Deploy'),
              titleAlignment: 'center',
            },
          )

          this.log(`\n${successMessage}`)
        } else {
          this.log(`Uploaded successfully: ${txOrManifestId}\nVisit your site: https://gateway.s3-node-1.load.network/resolve/preview/${txOrManifestId}`)
        }
      } catch (error) {
        this.error(
          chalk.red(`Deployment failed: ${error instanceof Error ? error.message : String(error)}`),
        )
      }
    } catch (error) {
      // Handle user cancellation (Ctrl+C)
      if (error instanceof Error && error.name === 'ExitPromptError') {
        this.log(chalk.yellow('\n\n👋 Deployment cancelled'))
        this.exit(0)
      }

      throw error
    }
  }
}

async function anchorPreviewManifest({
  previewId,
  deployKey,
}: {
  previewId: string
  deployKey: string
}): Promise<void> {
  const { signer, token } = createSigner('arweave', deployKey)
  const turbo = TurboFactory.authenticated({
    signer,
    token,
  })

  const balance = await turbo.getBalance().catch(() => null)
  if (balance) {
    console.log(`Turbo balance: ${balance.winc}`)
  }

  const manifestResponse = await fetch(
    `https://gateway.s3-node-1.load.network/resolve/${previewId}`,
  )
  if (!manifestResponse.ok) {
    throw new Error(`Failed to fetch preview manifest: ${manifestResponse.status}`)
  }

  const manifest = (await manifestResponse.json()) as {
    paths?: Record<string, { id?: string }>
    fallback?: { id?: string }
  }
  const paths = manifest.paths || {}
  const ids = new Set<string>()

  for (const entry of Object.values(paths)) {
    if (entry?.id) {
      ids.add(entry.id)
    }
  }

  if (manifest.fallback?.id) {
    ids.add(manifest.fallback.id)
  }

  console.log(`Anchoring ${ids.size} dataitems from preview manifest`)

  for (const id of ids) {
    console.log(`Anchoring dataitem: ${id}`)
    const binary = await fetch(`https://gateway.s3-node-1.load.network/binary/${id}`)
    if (!binary.ok) {
      throw new Error(`Failed to fetch dataitem binary: ${id}`)
    }

    const buffer = Buffer.from(await binary.arrayBuffer())
    await turbo.uploadSignedDataItem({
      dataItemStreamFactory: () => Readable.from(buffer),
      dataItemSizeFactory: () => buffer.length,
    })
  }

  const manifestBinary = await fetch(
    `https://gateway.s3-node-1.load.network/binary/${previewId}`,
  )
  if (!manifestBinary.ok) {
    throw new Error(`Failed to fetch manifest binary: ${previewId}`)
  }

  const manifestBuffer = Buffer.from(await manifestBinary.arrayBuffer())
  await turbo.uploadSignedDataItem({
    dataItemStreamFactory: () => Readable.from(manifestBuffer),
    dataItemSizeFactory: () => manifestBuffer.length,
  })
  console.log(`Anchored manifest: ${previewId}`)
}
