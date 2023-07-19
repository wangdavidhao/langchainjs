// eslint-disable-next-line import/no-extraneous-dependencies
import {aws4Interceptor} from 'aws4-axios';
import axios from 'axios';
import { LLM, BaseLLMParams } from './base.js';
import { LLMChain, PromptTemplate } from '../index.js';

const BEDROCK_SERVICE_NAME = 'bedrock'

export abstract class BaseBedrockContentHandler<InputType, OutputType> {
    /** The MIME type of the input data passed to endpoint */
    contentType = "text/plain";
  
    /** The MIME type of the response data returned from endpoint */
    accepts = "text/plain";
  
    /**
     * Transforms the input to a format that model can accept as the request Body.
     * Should return bytes or seekable file like object in the format specified in
     * the contentType request header.
     */
    abstract transformInput(
      prompt: InputType,
      modelKwargs: Record<string, unknown>
    ): Promise<Uint8Array>;

    /**
     * Transforms the output from the model to string that the LLM class expects.
     */
    abstract transformOutput(output: Uint8Array): Promise<OutputType>;
  }
  
  /** Content handler for LLM class. */
  export type BedrockLLMContentHandler = BaseBedrockContentHandler<
    string,
    string
  >;

export interface BedrockEndpointInput extends BaseLLMParams {
  region: string;
  roleArn: string;
  model: string;
  stream?: boolean;
  contentHandler: BedrockLLMContentHandler;
  modelKwargs?: Record<string, unknown>;
}

export class BedrockEndpoint extends LLM {

  region: string;

  roleArn: string;

  model: string;

  client: any;

  stream?: boolean;

  contentHandler: BedrockLLMContentHandler;

  modelKwargs?: Record<string, unknown>;


  constructor(fields: BedrockEndpointInput) {

    super(fields ?? {});
    
    this.region = fields.region;
    this.roleArn = fields.roleArn;
    this.model = fields.model;
    this.stream = fields.stream;
    this.contentHandler = fields.contentHandler;
    this.modelKwargs = fields.modelKwargs;

    const interceptor = aws4Interceptor({
        options: {
        region: this.region,
        service: BEDROCK_SERVICE_NAME,
        assumeRoleArn:this.roleArn,
        },
      });

    this.client = axios.default.create({
        headers: { accept: '*/*' },
      });
    this.client.interceptors.request.use(interceptor);

  }

  _llmType() {
    return 'bedrock_endpoint';
  }

  getModelsParams = (prompt:string, model:string) => {
    
    switch (model) {
      case 'amazon.titan-tg1-large': {
          return  {
            "inputText":prompt,
            "textGenerationConfig": {
              "maxTokenCount":4000,
              "temperature":0.0,
              "stopSequences":[]
          }
          }
      }

      case 'anthropic.claude-v1':
      case 'anthropic.claude-instant-v1': {
          return {
            "prompt": prompt, //  inputText: titan
            "max_tokens_to_sample": 200
          }
      }

      default:
        return null
  }}

  getModelsOptions = ( model:string) => {
    
    switch (model) {
      case 'amazon.titan-tg1-large': {
          return  {
            headers:{
              "accept": "application/vnd.amazon.eventstream",
              "content-type": "application/json",
              "x-amzn-bedrock-accept": "*/*",
              "x-amzn-bedrock-save": true
            },
            responseType: "stream"
          }
      }

      case 'anthropic.claude-instant-v1': {
          return {
            headers:{
              "accept": "application/vnd.amazon.eventstream",
              "content-type": "application/json",
            },
            responseType: "stream"
          }
      }

      default:
        return null
  }}


    

  async _call(
    prompt: string,
  ): Promise<string> {
    let response;
    if (this.stream){

      response = await this.client.post(`https://bedrock.${this.region}.amazonaws.com/model/${this.model}/invoke-with-response-stream`, this.getModelsParams(prompt,this.model), this.getModelsOptions(this.model) )
      const stream = response.data
      return stream.on('data', (chunk: any) => { 
        const startIndex = chunk.indexOf('{"bytes":"') + '{"bytes":"'.length
        const endIndex = chunk.indexOf('"}', startIndex)
        const base64Data = chunk.toString().substring(startIndex, endIndex)
    
        const jsonData = JSON.parse(Buffer.from(base64Data, 'base64').toString('utf-8'))
        return jsonData
        // return jsonData.completion.toString();
      })
    } else {
      response = await this.client.post(`https://bedrock.${this.region}.amazonaws.com/model/${this.model}/invoke`, 
        this.getModelsParams(prompt,this.model),
        
     )
    return response.data
    }
    // return this.contentHandler.transformOutput(response.results);
  }
}

class SimpleContentHandler {
    contentType = "application/json";

    accepts = "application/json";

    async transformInput(prompt:string, modelKwargs:Record<string, unknown>) {
        const inputString = JSON.stringify({
            prompt,
            ...modelKwargs,
        });
        return Buffer.from(inputString);
    }

    async transformOutput(output:Uint8Array) {
        const responseJson = JSON.parse(Buffer.from(output).toString("utf-8"));
        return responseJson.completions[0].data.text
    }
}

const contentHandler = new SimpleContentHandler();

const model = new BedrockEndpoint({
    roleArn:"arn:aws:iam::536144235884:role/LambdaAssumeRole-811912857283",
    region:"us-east-1",
    model:"anthropic.claude-v1", // anthropic.claude-v1 amazon.titan-tg1-large
    contentHandler,
})


const template = `
Your are a professional blog translator, translate an HTML AWS blog segment from {sourceLanguage} to {targetLanguage}.
{sourceLanguage} text: {content}
{targetLanguage} text:
`
const prompt = new PromptTemplate({
    template,
    inputVariables: ["content", "sourceLanguage", "targetLanguage", "guidelines"],
});
const chain = new LLMChain({llm: model, prompt});
    


const res = await chain.call({
    content : 'Lambda function are serverless',
    sourceLanguage: "en-US",
    targetLanguage: "fr-FR",
});

console.log(res.text.completion)